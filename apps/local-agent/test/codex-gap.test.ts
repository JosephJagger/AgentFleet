import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexOperation, parseReviewTarget, sanitizeCodexResult } from "../src/codex-operations.js";
import { executeCodexOperation } from "../src/codex-operation-executor.js";
import { queryReference } from "../src/reference-tool.js";

test("reference queries are scoped, bounded, literal and retain incomplete-history identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "af-reference-test-"));
  try {
    const id = `ls_${"a".repeat(32)}`;
    const file = { name: `reference-1-${id}.md`, path: join(dir, "reference.md") };
    await writeFile(file.path, "# Referenced session\nHistory: Partial\nContent version: 1:1:42\n\nUser: inspect [abc]\nCodex: changed files\nUser: inspect [abc]\n");
    const read = await queryReference([file], { referenceId: id, query: "[abc]", limit: 1 });
    assert.equal(read.success, true);
    const value = JSON.parse(read.contentItems[0]!.text);
    assert.match(value.header, /History: Partial/); assert.equal(value.nextLine, 7);
    assert.match(value.passages, /^5:/);
    assert.equal((await queryReference([], { referenceId: id })).success, false);
    assert.equal((await queryReference([file], { referenceId: id, path: "/etc/passwd" })).success, false);
    assert.equal((await queryReference([file], { referenceId: id, limit: 101 })).success, false);
    if (process.platform !== "win32") {
      const link = join(dir, "link"); await symlink(file.path, link);
      assert.equal((await queryReference([{ ...file, path: link }], { referenceId: id })).success, false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("management rejects arbitrary RPCs, unknown fields and unconfirmed mutations", () => {
  assert.throws(() => parseCodexOperation({ operation: "fs/writeFile", arguments: {} }));
  assert.throws(() => parseCodexOperation({ operation: "resetCard.consume", arguments: {} }));
  assert.throws(() => parseCodexOperation({ operation: "plugin.install", arguments: { pluginName: "p", remoteMarketplaceName: "m", confirmed: true, path: "/secret" } }));
  assert.throws(() => parseCodexOperation({ operation: "goal.set", arguments: { tokenBudget: -1 } }));
  assert.deepEqual(parseReviewTarget({ type: "baseBranch", branch: "main" }), { type: "baseBranch", branch: "main" });
  assert.throws(() => parseReviewTarget({ type: "commit", sha: "$(shell)" }));
  assert.throws(() => parseReviewTarget({ type: "custom", instructions: "review", approvalsReviewer: "auto_review" }));
});

test("reset consumption reuses logical operation ID and refreshes quota, never returns credentials", async () => {
  const calls: unknown[] = []; let refreshed = 0;
  const run = () => executeCodexOperation({ operation: "resetCard.consume", arguments: { confirmed: true } }, "thread", "same-id", async (method, params) => { calls.push({ method, params }); return { outcome: "alreadyRedeemed", accessToken: "secret" }; }, async () => { refreshed++; });
  const result = await run(); await run();
  assert.equal(refreshed, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal(result.status, "alreadyRedeemed"); assert.ok(!JSON.stringify(result).includes("secret"));
});

test("official usage nulls are unavailable, zero remains zero, and token route stays separate", async () => {
  const empty = await executeCodexOperation({ operation: "usage.read" }, "thread", "id", async () => ({ summary: { lifetimeTokens: null }, dailyUsageBuckets: null }), async () => {});
  assert.equal(empty.status, "unavailable"); assert.deepEqual(empty.rows, []);
  const used = await executeCodexOperation({ operation: "usage.read", arguments: { scope: "thread" } }, "exact-thread", "id", async (method, params) => {
    assert.equal(method, "account/usage/read"); assert.deepEqual(params, { threadId: "exact-thread" });
    return { summary: { lifetimeTokens: 0 }, threadUsage: { estimatedUsageCreditsMicros: 1250000 } };
  }, async () => {});
  assert.equal(used.rows[0]!.detail, "0"); assert.equal(used.rows[1]!.detail, "1.25");
});

test("browser result sanitization drops credentials and non-https OAuth URLs", () => {
  const result = sanitizeCodexResult({ operation: "mcp.login", status: "completed", rows: [], url: "javascript:alert(1)", token: "secret" });
  assert.deepEqual(result, { operation: "mcp.login", status: "completed", rows: [] });
});

test("experimental reads stay scoped to the bound thread and require explicit opt-in", async () => {
  assert.throws(() => parseCodexOperation({ operation: "history.search", arguments: { searchTerm: "needle" } }));
  const result = await executeCodexOperation({ operation: "history.search", arguments: { experimental: true, searchTerm: "needle", cursor: "next" } }, "bound-thread", "id", async (method, params) => {
    assert.equal(method, "thread/searchOccurrences"); assert.deepEqual(params, { threadId: "bound-thread", searchTerm: "needle", cursor: "next", limit: 25 });
    return { data: [{ turnId: "turn", itemId: "item", snippet: "needle here", credentials: "not uploaded" }], nextCursor: "page-2" };
  }, async () => {});
  assert.equal(result.nextCursor, "page-2"); assert.equal(result.rows[0]?.detail, "needle here");
  assert.ok(!JSON.stringify(result).includes("not uploaded"));
});

test("live settings are exact-turn only and targetUnavailable is not success", async () => {
  assert.throws(() => parseCodexOperation({ operation: "turn.settings", arguments: { confirmed: true, experimental: true, mode: "default" } }));
  const operation = { operation: "turn.settings", arguments: { experimental: true, confirmed: true, model: "advertised-model", effort: "medium", serviceTier: null } };
  await assert.rejects(executeCodexOperation(operation, "thread", "id", async () => assert.fail("Cannot update an ended turn"), async () => {}));
  const result = await executeCodexOperation(operation, "thread", "id", async (method, params) => {
    assert.equal(method, "turn/settings/update"); assert.deepEqual(params, { threadId: "thread", turnId: "current-turn", model: "advertised-model", effort: "medium", serviceTier: null });
    return { status: "targetUnavailable" };
  }, async () => {}, "current-turn");
  assert.equal(result.status, "targetUnavailable");
});

test("MCP elicitation preserves booleans, numbers, optional omission, and rejects secret or unsupported forms", async () => {
  const { elicitationForm, elicitationContent } = await import("../src/mcp-elicitation.js");
  const form = elicitationForm({ mode: "form", message: "Choose", requestedSchema: { type: "object", required: ["count", "enabled"], properties: { count: { type: "integer", minimum: 1, maximum: 5 }, enabled: { type: "boolean" }, note: { type: "string" } } } });
  const content = elicitationContent({ count: { answers: ["3"] }, enabled: { answers: ["false"] }, note: { answers: ["[omit]"] } }, form.questions, form.fields);
  assert.deepEqual({ ...content }, { count: 3, enabled: false });
  assert.throws(() => elicitationContent({ count: { answers: ["6"] }, enabled: { answers: ["false"] }, note: { answers: ["[omit]"] } }, form.questions, form.fields));
  for (const properties of [{ password: { type: "string" } }, { nested: { type: "object" } }, { "__proto__": { type: "string" } }, { field: { type: "string", format: "password" } }]) assert.throws(() => elicitationForm({ mode: "form", message: "Choose", requestedSchema: { type: "object", properties } }));
  assert.throws(() => elicitationForm({ mode: "url", message: "Authorize", url: "https://example.test" }));
});

test("experimental configuration writes only the verified key with native optimistic concurrency", async () => {
  const calls: unknown[] = [];
  const result = await executeCodexOperation({ operation: "experiment.configure", arguments: { enabled: true, confirmed: true, experimental: true } }, "thread", "id", async (method, params) => {
    calls.push({ method, params });
    if (method === "config/read") return { layers: [{ name: { type: "user" }, version: "native-version", config: { api_key: "never upload" } }] };
    return { status: "ok", version: "new-version", filePath: "/private/config.toml" };
  }, async () => {});
  assert.deepEqual(calls[1], { method: "config/value/write", params: { keyPath: "features.step_model_switching", value: true, mergeStrategy: "replace", expectedVersion: "native-version" } });
  assert.equal(result.status, "savedRequiresReconnect"); assert.ok(!JSON.stringify(result).includes("never upload"));
  assert.throws(() => parseCodexOperation({ operation: "experiment.configure", arguments: { enabled: true, confirmed: true, experimental: true, keyPath: "approval_policy" } }));
});

test("structured output uses bounded strict schemas and is forwarded to native turn/start", async () => {
  const { parseOutputSchema } = await import("../src/output-schema.js");
  const { CodexAppServer } = await import("../src/app-server.js");
  const schema = { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false };
  assert.deepEqual(parseOutputSchema(schema), schema);
  for (const bad of [{ ...schema, additionalProperties: true }, { ...schema, required: [] }, { ...schema, $ref: "https://example.test/schema" }, { ...schema, properties: { result: { type: "string", pattern: "(a+)+" } } }]) assert.throws(() => parseOutputSchema(bad));
  const dir = await mkdtemp(join(tmpdir(), "af-output-test-"));
  try {
    const server = new CodexAppServer({} as never, "epoch");
    const internal = server as unknown as { initialized: boolean; child: unknown; request(method: string, params: Record<string, unknown>): Promise<unknown> };
    internal.initialized = true; internal.child = {};
    internal.request = async (method, params) => { assert.equal(method, "turn/start"); assert.deepEqual(params.outputSchema, schema); return { turn: { id: "turn", status: "inProgress" } }; };
    await server.startTurn({ nativeThreadId: "thread", appServerEpoch: "epoch", policyVerified: true } as never, { root: dir } as never, "reply", undefined, undefined, undefined, { outputSchema: schema });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("plugin installation resolves only listed native marketplaces, never caller-supplied paths", async () => {
  let installed = false;
  const run = (pluginName: string) => executeCodexOperation({ operation: "plugin.install", arguments: { pluginName, remoteMarketplaceName: "known", confirmed: true } }, "thread", "mutation", async (method, params) => {
    if (method === "plugin/list") return { marketplaces: [{ name: "known", path: "/native/marketplace", plugins: [{ name: "example" }] }] };
    assert.equal(method, "plugin/install"); assert.deepEqual(params, { pluginName: "example", marketplacePath: "/native/marketplace", installAttemptId: "mutation" }); installed = true; return {};
  }, async () => {});
  await assert.rejects(run("unlisted")); assert.equal(installed, false);
  await run("example"); assert.equal(installed, true);
  assert.throws(() => parseCodexOperation({ operation: "marketplace.add", arguments: { confirmed: true, source: "https://user:password@github.com/example/repo" } }));
});

test("native activity events show useful status without raw hook commands or auth errors", async () => {
  const { codexNotification } = await import("../src/codex-notifications.js");
  const hook = codexNotification("hook/completed", { threadId: "thread", turnId: "turn", run: { id: "hook", eventName: "SessionStart", handlerType: "command", status: "completed", sourcePath: "/secret", entries: [{ text: "private output" }] } });
  assert.equal(hook?.type, "codex.hook_status"); assert.equal(hook?.nativeItemId, "hook"); assert.ok(!JSON.stringify(hook).includes("private output")); assert.ok(!JSON.stringify(hook).includes("/secret"));
  assert.equal(codexNotification("unknown/event", { threadId: "thread" }), null);
  const recovery = codexNotification("modelProvider/authRecoveryStarted", { threadId: "thread", provider: "openai", message: "token secret" });
  assert.ok(!JSON.stringify(recovery).includes("token secret"));
});

test("native turn-start identity grants references before cloud task projection catches up", async () => {
  const { CodexAppServer } = await import("../src/app-server.js");
  const dir = await mkdtemp(join(tmpdir(), "af-reference-start-"));
  try {
    const id = `ls_${"b".repeat(32)}`; const file = { name: `reference-1-${id}.md`, path: join(dir, "reference.md") }; await writeFile(file.path, "History: readable\nUser: referenced task\n");
    const thread = { nativeThreadId: "thread", appServerEpoch: "epoch", policyVerified: true };
    const writes: Record<string, unknown>[] = [];
    const server = new CodexAppServer({ findManagedThread: () => thread, onEvent: async () => {} } as never, "epoch");
    const internal = server as unknown as { turnReferences: Map<string, unknown>; handleLine(line: string): Promise<void>; writeLine(value: Record<string, unknown>): Promise<void> };
    internal.turnReferences.set("thread", [file]); internal.writeLine = async value => { writes.push(value); };
    await internal.handleLine(JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "new-turn", status: "inProgress" } } }));
    await internal.handleLine(JSON.stringify({ id: 1, method: "item/tool/call", params: { threadId: "thread", turnId: "new-turn", tool: "agentfleet_reference_read", arguments: { referenceId: id } } }));
    assert.equal((writes[0]?.result as {success:boolean}).success, true);
    await internal.handleLine(JSON.stringify({ id: 2, method: "item/tool/call", params: { threadId: "thread", turnId: "other-turn", tool: "agentfleet_reference_read", arguments: { referenceId: id } } }));
    assert.equal((writes[1]?.result as {success:boolean}).success, false);
    await internal.handleLine(JSON.stringify({ id: 3, method: "item/tool/call", params: { threadId: "thread", tool: "agentfleet_reference_read", arguments: { referenceId: id } } }));
    assert.equal((writes[2]?.result as {success:boolean}).success, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("idle session goal operations restore a verified writer and preserve successful receipt on cleanup failure", async () => {
  const { SessionAppServer } = await import("../src/session-app-server.js");
  let created = 0; let resumed = 0; let released = 0; let valid = true; let failRelease = false;
  const server = new SessionAppServer({ findProject: () => ({ root: "/project" }), findManagedThread: () => undefined } as never, (_callbacks, epoch) => {
    created++;
    return { appServerEpoch: epoch, start: async () => {}, stop: async () => {},
      resumeThread: async (id: string, _project: unknown, _cwd: unknown, _profile: unknown, metadataOnly: boolean) => { assert.equal(metadataOnly, true, "metadata operations suppress autonomous goals on restore"); resumed++; return { nativeThreadId: id, policyVerified: valid }; },
      releaseWriter: async () => { released++; if (failRelease) throw new Error("pending cleanup"); },
      manageCodex: async () => ({ operation: "goal.clear", status: "completed", rows: [] }) } as never;
  });
  const thread = { nativeThreadId: "thread", projectId: "project", permissionProfile: "project" } as never;
  const request = { operation: "goal.clear", arguments: { confirmed: true } };
  try {
    await server.manageCodex(thread, request, "1"); assert.equal(created, 2); assert.equal(resumed, 1); assert.equal(released, 1);
    valid = false; await assert.rejects(server.manageCodex(thread, request, "2"), /policy/); assert.equal(released, 2);
    valid = true; failRelease = true;
    assert.equal((await server.manageCodex(thread, request, "3")).status, "completed");
    const count = created; await server.manageCodex(thread, request, "4"); assert.equal(created, count, "failed release retains its writer instead of creating an overlapping process");
  } finally { await server.stop(); }
});

test("native queue edits are scoped to an existing entry and reordering must include the complete queue", async () => {
  const calls: string[] = [];
  const rpc = async (method: string, params: Record<string, unknown> | null) => {
    calls.push(method);
    assert.equal(params?.threadId, "exact-thread");
    if (method === "thread/queue/list") return { data: [{ id: "entry-a" }, { id: "entry-b" }] };
    if (method === "thread/queue/update") assert.deepEqual(params, { threadId: "exact-thread", queuedSubmissionId: "entry-a", input: [{ type: "text", text: "updated" }] });
    else if (method === "thread/queue/reorder") assert.deepEqual(params?.queuedSubmissionIds, ["entry-b", "entry-a"]);
    return {};
  };
  const run = (operation: string, args: Record<string, unknown>) => executeCodexOperation({ operation, arguments: { ...args, confirmed: true, experimental: true } }, "exact-thread", "id", rpc, async () => {});
  await assert.rejects(run("nativeQueue.delete", { submissionId: "foreign" })); assert.deepEqual(calls, ["thread/queue/list"]);
  await assert.rejects(run("nativeQueue.reorder", { submissionIds: ["entry-a"] }));
  await run("nativeQueue.reorder", { submissionIds: ["entry-b", "entry-a"] });
  await run("nativeQueue.update", { submissionId: "entry-a", text: "updated" });
  assert.throws(() => parseCodexOperation({ operation: "nativeQueue.reorder", arguments: { submissionIds: ["entry-a", "entry-a"], confirmed: true, experimental: true } }));
});

test("native attachment changes own only panel notes and opaque pagination cursors roundtrip", async () => {
  await executeCodexOperation({ operation: "attachment.note", arguments: { identityKey: "note", text: "saved", confirmed: true } }, "thread", "id", async (method, params) => {
    assert.equal(method, "thread/attachment/add"); assert.deepEqual(params, { threadId: "thread", attachmentType: "agentfleet.note", identityKey: "note", payload: { text: "saved" } }); return {};
  }, async () => {});
  assert.throws(() => parseCodexOperation({ operation: "attachment.remove", arguments: { identityKey: "note", attachmentType: "file", confirmed: true } }));
  const cursor = "c".repeat(4000); assert.equal(parseCodexOperation({ operation: "attachments.read", arguments: { cursor } }).arguments.cursor, cursor);
  assert.throws(() => parseCodexOperation({ operation: "attachments.read", arguments: { cursor: "c".repeat(4097) } }));
});

test("direct MCP calls require confirmation and native inventory membership, never arbitrary resource paths", async () => {
  let invoked = 0;
  const run = (operation: string, arguments_: Record<string, unknown>) => executeCodexOperation({ operation, arguments: arguments_ }, "exact-thread", "id", async (method, params) => {
    assert.equal(params?.threadId, "exact-thread");
    if (method === "mcpServerStatus/list") return { data: [{ name: "known", tools: { echo: { description: "echo" } }, resources: [{ uri: "af://note" }] }] };
    invoked++; return method === "mcpServer/tool/call" ? { content: [{ type: "text", text: "done" }] } : { contents: [{ text: "note" }] };
  }, async () => {});
  await assert.rejects(run("mcp.call", { name: "known", tool: "unlisted", input: {}, confirmed: true })); assert.equal(invoked, 0);
  await assert.rejects(run("mcp.resource", { name: "known", uri: "file:///etc/passwd" })); assert.equal(invoked, 0);
  assert.equal((await run("mcp.call", { name: "known", tool: "echo", input: { text: "hello" }, confirmed: true })).rows[0]?.detail, "done");
  assert.throws(() => parseCodexOperation({ operation: "mcp.call", arguments: { name: "known", tool: "echo", input: { api_key: "secret" }, confirmed: true } }));
  assert.throws(() => parseCodexOperation({ operation: "mcp.call", arguments: { name: "known", tool: "echo", input: {} } }));
});

test("native workspace tools keep project roots and command policy fixed, and reject directory escapes", async () => {
  const { executeCodexWorkspaceOperation } = await import("../src/codex-workspace-operations.js");
  const { stat, realpath } = await import("node:fs/promises");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "af-workspace-gap-")));
  const outside = await mkdtemp(join(tmpdir(), "af-workspace-other-"));
  try {
    await writeFile(join(dir, "visible.ts"), "file");
    const info = await stat(dir); const project = { root: dir, device: String(info.dev), inode: String(info.ino) } as never;
    const thread = { sessionCwd: dir, permissionProfile: "project" } as never;
    const calls: string[] = [];
    const rpc = async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === "command/exec") {
        assert.deepEqual(params.command, ["git", "status"]); assert.equal(params.cwd, dir);
        assert.deepEqual(params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
        assert.equal(params.timeoutMs, 30000); return { exitCode: 0, stdout: "done", stderr: "" };
      }
      if (method === "fs/readDirectory") { assert.equal(params.path, dir); return { entries: [{ fileName: "visible.ts", isFile: true }, { fileName: ".env", isFile: true }, { fileName: "../outside" }] }; }
      assert.deepEqual(params.roots, [dir]); return { files: [{ root: dir, path: "visible.ts", file_name: "visible.ts" }, { root: outside, path: "secret", file_name: "secret" }, { root: dir, path: ".env", file_name: ".env" }] };
    };
    const run = (operation: string, arguments_: Record<string, unknown>) => executeCodexWorkspaceOperation(parseCodexOperation({ operation, arguments: arguments_ }), thread, project, rpc);
    assert.equal((await run("terminal.run", { argv: ["git", "status"], confirmed: true })).status, "completed");
    assert.deepEqual((await run("files.list", {})).rows.map(row => row.name), ["visible.ts"]);
    assert.deepEqual((await run("files.search", { query: "visible" })).rows.map(row => row.name), ["visible.ts"]);
    assert.throws(() => parseCodexOperation({ operation: "terminal.run", arguments: { argv: ["git"], confirmed: true, env: { EVIL: "1" } } }));
    assert.throws(() => parseCodexOperation({ operation: "files.list", arguments: { path: "../escape" } }));
    if (process.platform !== "win32") {
      await symlink(outside, join(dir, "escape")); const count = calls.length;
      await assert.rejects(run("files.list", { path: "escape" })); assert.equal(calls.length, count);
    }
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("current time callbacks only answer the verified managed session", async () => {
  const { CodexAppServer } = await import("../src/app-server.js");
  const writes: Record<string, unknown>[] = [];
  const server = new CodexAppServer({ findManagedThread: (id: string) => id === "thread" ? { nativeThreadId: id, appServerEpoch: "epoch", policyVerified: true } : undefined } as never, "epoch");
  const internal = server as unknown as { handleLine(line: string): Promise<void>; writeLine(value: Record<string, unknown>): Promise<void> };
  internal.writeLine = async value => { writes.push(value); };
  const before = Math.floor(Date.now() / 1000);
  await internal.handleLine(JSON.stringify({ id: 1, method: "currentTime/read", params: { threadId: "thread" } }));
  assert.ok(Number((writes[0]?.result as { currentTimeAt: number }).currentTimeAt) >= before);
  await internal.handleLine(JSON.stringify({ id: 2, method: "currentTime/read", params: { threadId: "other" } }));
  assert.equal((writes[1]?.error as { code: number }).code, -32602);
});

test("fork boundaries are exact, goals are deferred, and confirmed fork receipts survive cleanup failures", async () => {
  const { parseForkRange } = await import("../src/codex-operations.js");
  const { CodexAppServer } = await import("../src/app-server.js");
  assert.throws(() => parseForkRange({ beforeTurnId: "a", lastTurnId: "b" }));
  assert.throws(() => parseForkRange({ path: "/private/rollout" }));
  const dir = await mkdtemp(join(tmpdir(), "af-fork-gap-"));
  try {
    const server = new CodexAppServer({} as never, "epoch");
    const internal = server as unknown as { initialized: boolean; child: unknown; request(method: string, params: Record<string, unknown>): Promise<unknown> };
    internal.initialized = true; internal.child = {};
    internal.request = async (method, params) => {
      if (method === "thread/read") return { thread: { id: "source", cwd: dir, status: { type: "idle" } } };
      if (method === "thread/unsubscribe") throw new Error("cleanup pending");
      assert.equal(method, "thread/fork"); assert.equal(params.beforeTurnId, "boundary"); assert.equal(params.deferGoalContinuation, true); assert.equal(params.excludeTurns, true);
      assert.equal(params.cwd, dir); return { thread: { id: "fork", cwd: dir } };
    };
    const result = await server.threadAction({ nativeThreadId: "source" } as never, { root: dir } as never, "fork", undefined, undefined, { beforeTurnId: "boundary" });
    assert.deepEqual(result, { forkedNativeThreadId: "fork", sourceNativeThreadId: "source", writerReleased: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("goal management saves paused metadata and rejects autonomous activation", async () => {
  assert.throws(() => parseCodexOperation({ operation: "goal.set", arguments: { objective: "work", status: "active" } }));
  const request = parseCodexOperation({ operation: "goal.set", arguments: { objective: "work" } });
  assert.equal(request.arguments.status, "paused");
  await executeCodexOperation(request, "thread", "mutation", async (method, params) => {
    assert.equal(method, "thread/goal/set"); assert.deepEqual(params, { threadId: "thread", objective: "work", status: "paused" }); return { goal: { status: "paused" } };
  }, async () => {});
});

test("reset card expiry preserves native seconds, distinguishes null and missing, and never consumes a card",async()=>{
 const result=await executeCodexOperation({operation:'resetCards.read'},'thread','read-only',async(method,params)=>{
  assert.equal(method,'account/rateLimits/read');assert.equal(params,null);
  return {rateLimitResetCredits:{availableCount:4,credits:[
   {id:'dated',title:'Full reset',status:'available',expiresAt:1791417600},
   {id:'permanent',status:'available',expiresAt:null},
   {id:'missing',status:'unknown'},
   {id:'invalid',status:'available',expiresAt:1e30},
  ]}};
 },async()=>assert.fail('Reading cards must not refresh through consumption'));
 assert.match(result.rows[1]!.detail,/2026-10-08 00:00:00 UTC/);
 assert.match(result.rows[2]!.detail,/不过期（原生注明）/);
 assert.match(result.rows[3]!.detail,/未返回有效期/);
 assert.match(result.rows[4]!.detail,/未返回有效期/);
 assert.equal(result.rows[1]!.status,'可用');
});
