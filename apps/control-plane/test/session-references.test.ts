import test from "node:test";
import assert from "node:assert/strict";
import { SessionReferences } from "../src/session-references.js";
import type { Principal } from "../src/auth.js";
import type { ControlPlaneDatabase } from "../src/db.js";
import type { RegistryService } from "../src/registry.js";
import type { CoordinationService } from "../src/coordination.js";
import type { WritingAI } from "../src/writing-ai.js";
import { AppError } from "../src/errors.js";

const principal = { userId: "user", workspaceId: "workspace" } as Principal;
function item(text: string, seq: number) { return { sessionSeq: seq, payloadState: "present", payload: { item: { type: "userMessage", content: [{ type: "text", text }] } } }; }
async function finished(refs: SessionReferences, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = refs.status(principal, id);
    if (job.state === "ready" || job.state === "failed") return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("summary did not finish");
}
test("reads every synced history page, summarizes ordered chunks, records incomplete history and caches by version", async () => {
  let version = 3, modelCalls = 0, pageCalls = 0;
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Source", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: version, historyCompleteness: "partial" }) } as unknown as RegistryService;
  const coordination = { historyPage: (_: unknown, _id: string, options: { beforeSeq?: number }) => {
    pageCalls++;
    return options.beforeSeq ? { items: [item("older", 1)], nextBeforeSeq: null, throughSeq: version } : { items: [item("newer", 3)], nextBeforeSeq: 2, throughSeq: version };
  } } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: async (_: unknown, input: string) => { modelCalls++; return input.includes("older") ? "old work" : input.includes("newer") ? "new work" : "combined"; } } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const first = await finished(refs, refs.start(principal, "source").id);
  assert.equal(first.state, "ready");
  assert.match(first.summary!, /not synchronized/);
  assert.equal(pageCalls, 4);
  assert.equal(modelCalls, 1);
  const cached = refs.start(principal, "source");
  assert.equal(cached.state, "ready");
  assert.equal(modelCalls, 1);
  version = 4;
  const changed = await finished(refs, refs.start(principal, "source").id);
  assert.equal(changed.state, "ready");
  assert.equal(modelCalls, 2);
});

test("cancelled summary cannot become ready after a late model result", async () => {
  let release!: (value: string) => void;
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Source", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: 1, historyCompleteness: "complete" }) } as unknown as RegistryService;
  const coordination = { historyPage: () => ({ items: [item("work", 1)], nextBeforeSeq: null, throughSeq: 1 }) } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: () => new Promise<string>(resolve => { release = resolve; }) } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const job = refs.start(principal, "source");
  await new Promise(resolve => setTimeout(resolve, 0));
  refs.cancel(principal, job.id);
  release("late result");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.throws(() => refs.status(principal, job.id));
});

test("streams a source larger than the former two-million-character cap without dropping pages", async () => {
  const pageCount = 110;
  const pageText = "x".repeat(20_000);
  let modelCalls = 0;
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Large", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: pageCount, historyCompleteness: "complete" }) } as unknown as RegistryService;
  const coordination = { historyPage: (_: unknown, _id: string, options: { beforeSeq?: number }) => {
    const index = options.beforeSeq === undefined ? pageCount : options.beforeSeq;
    return { items: [item(`${index}:${pageText}`, index)], nextBeforeSeq: index > 1 ? index - 1 : null, throughSeq: pageCount };
  } } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: async () => { modelCalls++; return "part"; } } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const result = await finished(refs, refs.start(principal, "source").id);
  assert.equal(result.state, "ready");
  assert.ok(modelCalls > 50 && modelCalls < pageCount, "all user text is summarized across bounded chunks without one model call per page");
  assert.equal(result.identity.version, `1:1:${pageCount}`);
});

test("does not send reasoning summaries or command execution logs to the summary model", async () => {
  const seen: string[] = [];
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Conversation", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: 4, historyCompleteness: "complete" }) } as unknown as RegistryService;
  const coordination = { historyPage: () => ({ items: [
    item("Please check the release", 1),
    { payloadState: "present", payload: { item: { type: "reasoning", summary: ["private reasoning marker"] } } },
    { payloadState: "present", payload: { item: { type: "commandExecution", command: "cat huge.log", aggregatedOutput: "secret command output marker" } } },
    { payloadState: "present", payload: { item: { type: "agentMessage", text: "Release is ready" } } },
  ], nextBeforeSeq: null, throughSeq: 4 }) } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: async (_: unknown, input: string) => { seen.push(input); return "handoff"; } } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const result = await finished(refs, refs.start(principal, "source").id);
  assert.equal(result.state, "ready");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /Please check the release/);
  assert.match(seen[0]!, /Release is ready/);
  assert.doesNotMatch(seen[0]!, /private reasoning marker|secret command output marker|cat huge.log/);
  assert.match(result.summary!, /command execution logs were not summarized/);
});

test("summarizes a 73k-character conversation in one model call", async () => {
  let modelCalls = 0;
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Conversation", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: 1, historyCompleteness: "complete" }) } as unknown as RegistryService;
  const coordination = { historyPage: () => ({ items: [item("A".repeat(73_000), 1)], nextBeforeSeq: null, throughSeq: 1 }) } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: async () => { modelCalls++; return "one summary"; } } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const result = await finished(refs, refs.start(principal, "source").id);
  assert.equal(result.state, "ready");
  assert.equal(modelCalls, 1);
});

test("falls back to parts only when the provider rejects the single-call context", async () => {
  let modelCalls = 0;
  const db = { get: () => ({ name: "Host" }) } as unknown as ControlPlaneDatabase;
  const registry = { getSession: () => ({ machineId: "host", projectAlias: "Project", title: "Conversation", projectionEpoch: 1, contentEpoch: 1, latestSessionSeq: 1, historyCompleteness: "complete" }) } as unknown as RegistryService;
  const coordination = { historyPage: () => ({ items: [item("B".repeat(73_000), 1)], nextBeforeSeq: null, throughSeq: 1 }) } as unknown as CoordinationService;
  const ai = { read: () => ({ enabled: true, configured: true }), referenceConfigurationVersion: () => "model-v1", summarizeHistory: async () => { modelCalls++; if (modelCalls === 1) throw new AppError(502, "REFERENCE_CONTEXT_LIMIT", "too large"); return "part"; } } as unknown as WritingAI;
  const refs = new SessionReferences(db, registry, coordination, ai);
  const result = await finished(refs, refs.start(principal, "source").id);
  assert.equal(result.state, "ready");
  assert.equal(modelCalls, 4); // rejected single call, two parts, one merge
});
