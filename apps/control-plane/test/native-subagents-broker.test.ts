import test from "node:test";
import assert from "node:assert/strict";
import { NativeSubagentsBroker, type SubagentsEndpoint } from "../src/native-subagents-broker.js";

const binding = { sessionId: "session", machineId: "host", projectId: "project", projectExternalId: "external", nativeThreadId: "parent", executionSegmentId: "segment", contentEpoch: 2 };
const page = () => ({ provider: "codex", items: [{ id: "child", title: "Check tests", status: "running", description: "Inspect test coverage" }], nextCursor: null });
function fixture(timeout = 1000) {
  const sent: Record<string, unknown>[] = [];
  let endpoint: SubagentsEndpoint | undefined = { key: {}, generation: 3, producerEpoch: "producer", appServerEpoch: "native", ready: true, supported: true, send: value => { sent.push(value); return true; } };
  const broker = new NativeSubagentsBroker(() => endpoint, timeout);
  return { broker, sent, endpoint: () => endpoint!, change: (patch: Partial<SubagentsEndpoint>) => { endpoint = { ...endpoint!, ...patch }; }, receive: (result: unknown = page()) => broker.receive("host", endpoint!.key, { requestId: sent.at(-1)!.requestId as string, result }) };
}

test("native reads bind exact host, socket, project, thread, segment and content epoch", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const pending = f.broker.read(binding, {}), request = f.sent[0]!;
  assert.equal(request.type, "subagents.read");
  for (const [key, value] of Object.entries({ logicalSessionId: "session", projectExternalId: "external", nativeThreadId: "parent", executionSegmentId: "segment", contentEpoch: 2, transportGeneration: 3, producerEpoch: "producer", appServerEpoch: "native" })) assert.equal(request[key], value);
  f.broker.receive("other-host", f.endpoint().key, { requestId: request.requestId as string, result: null });
  f.broker.receive("host", {}, { requestId: request.requestId as string, result: null });
  f.broker.receive("host", f.endpoint().key, { requestId: "unrelated", result: null });
  f.receive(); assert.deepEqual(await pending, page()); assert.equal(f.sent.length, 1);
});

test("routine reconciliation readiness changes preserve valid in-flight native reads", async t => {
  const f = fixture(); t.after(() => f.broker.close());
  const pending = f.broker.read(binding, {});
  f.change({ ready: false }); f.receive(); assert.deepEqual(await pending, page());
  assert.throws(() => f.broker.read(binding, {}), { code: "SUBAGENTS_HOST_OFFLINE" });
  assert.equal(f.sent.length, 1);
});

test("native restart or transport epoch changes fence the pending result", async () => {
  for (const change of [{ generation: 4 }, { producerEpoch: "replacement" }, { appServerEpoch: "replacement" }]) {
    const f = fixture();
    const pending = f.broker.read(binding, {});
    f.change(change); f.receive();
    await assert.rejects(pending, { code: "SUBAGENTS_TARGET_CHANGED" }); f.broker.close();
  }
  const f = fixture(), old = f.endpoint(), pending = f.broker.read(binding, {});
  f.change({ key: {} });
  f.broker.receive("host", old.key, { requestId: f.sent[0]!.requestId as string, result: page() });
  await assert.rejects(pending, { code: "SUBAGENTS_TARGET_CHANGED" }); f.broker.close();
});

test("timeout and late success never replay a native read or finish another request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(20); t.after(() => f.broker.close());
  const pending = f.broker.read(binding, {}), rejected = assert.rejects(pending, { code: "SUBAGENTS_TIMEOUT" });
  const oldId = f.sent[0]!.requestId as string;
  t.mock.timers.tick(21); await rejected;
  const next = f.broker.read(binding, { childId: "child" });
  f.broker.receive("host", f.endpoint().key, { requestId: oldId, result: page() });
  f.receive({ ...page(), childId: "child", messages: [{ role: "assistant", text: "Actual result" }] });
  assert.equal((await next).childId, "child"); assert.equal(f.sent.length, 2);
});

test("unsupported agents, failed sends, disconnects and shutdown return explicit failures", async () => {
  const f = fixture(); f.change({ supported: false });
  assert.throws(() => f.broker.read(binding, {}), { code: "SUBAGENTS_UNSUPPORTED" }); assert.equal(f.sent.length, 0);
  f.change({ supported: true, send: () => false }); await assert.rejects(f.broker.read(binding, {}), { code: "SUBAGENTS_HOST_OFFLINE" });
  f.change({ send: () => { throw new Error("socket closed"); } }); await assert.rejects(f.broker.read(binding, {}), { code: "SUBAGENTS_HOST_OFFLINE" });
  f.change({ send: value => { f.sent.push(value); return true; } });
  const disconnected = f.broker.read(binding, {}); f.broker.disconnect("unrelated", f.endpoint().key); f.broker.disconnect("host", {}); f.broker.disconnect("host", f.endpoint().key);
  await assert.rejects(disconnected, { code: "SUBAGENTS_HOST_OFFLINE" });
  const closing = f.broker.read(binding, {}); f.broker.close(); await assert.rejects(closing, { code: "SUBAGENTS_UNAVAILABLE" });
});

test("malformed, oversized and cross-child replies are rejected instead of displayed", async () => {
  const invalid: unknown[] = [null, [], { ...page(), provider: "other" }, { ...page(), childId: "other" }, { ...page(), nextCursor: "x".repeat(12001) }, { ...page(), items: Array(201).fill(page().items[0]) }, { ...page(), items: [{ id: "c", title: "t" }] }, { ...page(), items: [{ ...page().items[0], description: 42 }] }, { ...page(), messages: [{ role: "developer", text: "hidden" }] }, { ...page(), messages: [{ role: "assistant", text: "x".repeat(20001) }] }];
  for (const result of invalid) {
    const f = fixture(), pending = f.broker.read(binding, {}); f.receive(result);
    await assert.rejects(pending, { code: "SUBAGENTS_INVALID" }); f.broker.close();
  }
});

test("untrusted native error text is never relayed and pending reads are bounded per host", async () => {
  const f = fixture(), pending = f.broker.read(binding, {});
  f.broker.receive("host", f.endpoint().key, { requestId: f.sent[0]!.requestId as string, error: { code: "INTERNAL_SECRET", message: "credential=do-not-relay" } });
  await assert.rejects(pending, error => { assert.equal((error as { code: string }).code, "SUBAGENTS_READ_FAILED"); assert.ok(!String(error).includes("do-not-relay")); return true; });
  const reads = Array.from({ length: 8 }, () => f.broker.read(binding, {}));
  const settling = Promise.all(reads.map(read => assert.rejects(read, { code: "SUBAGENTS_UNAVAILABLE" })));
  assert.throws(() => f.broker.read(binding, {}), { code: "SUBAGENTS_BUSY" }); f.broker.close(); await settling;
});

test("native reply whitelist prevents extra data leaks and validates paginated message metadata", async () => {
  const message = { id: "reply", role: "assistant", text: "Actual reply", status: "completed", truncated: true, textOffset: 100, textLength: 200 };
  const good = fixture(), pending = good.broker.read(binding, { childId: "child" });
  good.receive({ ...page(), childId: "child", messages: [message] }); assert.deepEqual((await pending).messages, [message]); good.broker.close();
  const invalid: unknown[] = [
    { ...page(), rawTranscript: "must-not-leak" },
    { ...page(), items: [{ ...page().items[0], cwd: "/private/path" }] },
    ...[{ credentials: "must-not-leak" }, { id: "x".repeat(257) }, { status: "x".repeat(101) }, { truncated: "yes" }, { textOffset: -1 }, { textLength: 1.5 }, { textOffset: 201 }].map(change => ({ ...page(), messages: [{ ...message, ...change }] })),
    { ...page(), items: Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: "Task", status: "running", description: "中".repeat(10000) })) },
  ];
  for (const value of invalid) {
    const f = fixture(), read = f.broker.read(binding, {}); f.receive(value);
    await assert.rejects(read, { code: "SUBAGENTS_INVALID" }); f.broker.close();
  }
});
