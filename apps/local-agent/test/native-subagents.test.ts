import test from "node:test";
import assert from "node:assert/strict";
import { readCodexSubagents, nativeCollaborationContext } from "../src/native-subagents.js";
import { AgentRuntime } from "../src/runtime.js";
import { SessionAppServer } from "../src/session-app-server.js";
import type { AppServerCallbacks, AppServerClient } from "../src/app-server.js";
import type { ProjectRecord } from "../src/types.js";

test("Codex native children are parent-filtered before pagination and archived children remain reachable", async () => {
  const requests: Record<string, unknown>[] = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/read") return { thread: { id: "parent", cwd: "/project" } };
    assert.equal(method, "thread/list"); requests.push(params);
    assert.equal(params.parentThreadId, "parent"); assert.equal(params.cwd, "/project");
    assert.deepEqual(params.sourceKinds, ["subAgentThreadSpawn"]);
    assert.equal(params.limit, 25);
    return { data: [{ id: params.archived ? "archive" : params.cursor ? "next" : "first", parentThreadId: "parent", cwd: "/project", agentNickname: "Reviewer", status: { type: "active" } }, { id: "foreign", parentThreadId: "other", cwd: "/project" }, { id: "foreign-project", parentThreadId: "parent", cwd: "/elsewhere" }], nextCursor: !params.archived && !params.cursor ? "native-next" : null };
  };
  const first = await readCodexSubagents(rpc, "parent", "/project");
  const next = await readCodexSubagents(rpc, "parent", "/project", undefined, first.nextCursor);
  const archived = await readCodexSubagents(rpc, "parent", "/project", undefined, next.nextCursor);
  assert.deepEqual([...first.items, ...next.items, ...archived.items].map(child => child.id), ["first", "next", "archive"]);
  assert.equal(requests[1]?.cursor, "native-next"); assert.equal(archived.nextCursor, null);
});

test("Codex child reads enforce direct parent, exact project, and complete bounded long replies", async () => {
  let owner = "elsewhere", cwd = "/project", historyCalls = 0;
  const text = "原生回复".repeat(16000);
  const rpc = async (method: string, params: Record<string, unknown>) => {
    assert.equal(method, "thread/read", "no execution, resume, or subscription RPC is permitted");
    if (params.threadId === "parent") return { thread: { id: "parent", cwd: "/project" } };
    if (params.includeTurns) historyCalls++;
    return { thread: { id: "child", parentThreadId: owner, cwd, turns: [{ id: "turn", status: "completed", items: [{ id: "answer", type: "agentMessage", text }] }] } };
  };
  await assert.rejects(readCodexSubagents(rpc, "parent", "/project", "child"), { code: "SUBAGENTS_TARGET_CHANGED" });
  owner = "parent"; cwd = "/other";
  await assert.rejects(readCodexSubagents(rpc, "parent", "/project", "child"), { code: "SUBAGENTS_TARGET_CHANGED" });
  assert.equal(historyCalls, 0); cwd = "/project";
  let cursor: string | null = null, output = "", count = 0;
  do { const page = await readCodexSubagents(rpc, "parent", "/project", "child", cursor); output += page.messages!.map(message => message.text).join(""); cursor = page.nextCursor; assert.ok(++count <= 5); } while (cursor);
  assert.equal(output, text); assert.ok(historyCalls > 1);
});

test("invalid and stalled child list cursors fail closed", async () => {
  const rpc = async (method: string) => method === "thread/read" ? { thread: { id: "p", cwd: "/p" } } : { data: [], nextCursor: "same" };
  await assert.rejects(readCodexSubagents(rpc, "p", "/p", undefined, "bad"), { code: "SUBAGENTS_CURSOR_INVALID" });
  const cursor = Buffer.from(JSON.stringify({ archived: false, cursor: "same" })).toString("base64url");
  await assert.rejects(readCodexSubagents(rpc, "p", "/p", undefined, cursor), { code: "SUBAGENTS_INVALID" });
});

test("notLoaded is not completion; only native persisted terminal evidence marks children completed", async () => {
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/read") return { thread: { id: "parent", cwd: "/project" } };
    if (method === "thread/list") return { data: ["finished", "still-open"].map(id => ({ id, parentThreadId: "parent", cwd: "/project", historyMode: "paginated", status: { type: "notLoaded" } })), nextCursor: null };
    assert.equal(method, "thread/turns/list"); assert.equal(params.limit, 1); assert.equal(params.itemsView, "notLoaded");
    return { data: [{ status: params.threadId === "finished" ? "completed" : "inProgress" }] };
  };
  const page = await readCodexSubagents(rpc, "parent", "/project");
  assert.deepEqual(page.items.map(child => child.status), ["completed", "notLoaded"]);
});

test("native subagent facade reads without creating or acquiring a session writer", async () => {
  let factories = 0, reads = 0;
  const facade = new SessionAppServer({} as AppServerCallbacks, () => {
    factories++;
    return { readNativeSubagents: async () => { reads++; return { provider: "codex", items: [], nextCursor: null }; } } as unknown as AppServerClient;
  });
  await facade.readNativeSubagents("parent", {} as ProjectRecord, "/project");
  assert.equal(factories, 1); assert.equal(reads, 1);
});

test("runtime refuses foreign bindings and discards reads when sharing or connection changes", async () => {
  const binding = { nativeThreadId: "p", logicalSessionId: "s", executionSegmentId: "seg", contentEpoch: 1, codexProfileId: "profile", projectId: "project" };
  const state = { nativeThreadBindings: { p: binding }, projects: [{ id: "project", root: "/project" }], projectContentPolicies: { project: { syncContent: true } }, managedThreads: {}, discoveredThreads: {} };
  let reads = 0, revoke = false;
  const activities: boolean[] = [];
  const runtime = Object.assign(Object.create(AgentRuntime.prototype), { support: { readable: true, codexProfile: { id: "profile" } }, transportGeneration: 1, producerEpoch: "prod", store: { snapshot: () => structuredClone(state), setAuxiliaryActivity: (_: string, active: boolean) => activities.push(active) }, appServer: { appServerEpoch: "epoch", readNativeSubagents: async (id: string, project: ProjectRecord, cwd: string) => { assert.equal(id, "p"); assert.equal(project.root, cwd); reads++; if (revoke) state.projectContentPolicies.project.syncContent = false; return { provider: "codex", items: [], nextCursor: null }; } } }) as AgentRuntime;
  const target = { ...binding, projectExternalId: "project", transportGeneration: 1, producerEpoch: "prod", appServerEpoch: "epoch", requestId: "r" };
  await assert.rejects(runtime.readNativeSubagents({ ...target, logicalSessionId: "foreign" }), { code: "SUBAGENTS_TARGET_CHANGED" });
  await assert.rejects(runtime.readNativeSubagents({ ...target, transportGeneration: 2 }), { code: "SUBAGENTS_TARGET_CHANGED" });
  assert.equal(reads, 0);
  await runtime.readNativeSubagents(target); revoke = true;
  await assert.rejects(runtime.readNativeSubagents(target), { code: "SUBAGENTS_CONTENT_DISABLED" });
  assert.deepEqual(activities, [true, false, true, false]);
});

test("retired native orchestration guidance is cleared even for legacy enabled requests", () => {
  assert.deepEqual(nativeCollaborationContext(), { additionalContext: {} });
  assert.deepEqual(nativeCollaborationContext(false), { additionalContext: {} });
  assert.deepEqual(nativeCollaborationContext(true), { additionalContext: {} });
});
