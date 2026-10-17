import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AppEvent, AppServerCallbacks, AppServerClient } from "../src/app-server.js";
import type { MachineIdentity } from "../src/identity.js";
import { RelayConnection } from "../src/relay.js";
import { AgentRuntime } from "../src/runtime.js";
import { StateStore } from "../src/store.js";
import type { ManagedThread, PairingCredential, ProjectRecord, SupportReport } from "../src/types.js";

const identity: MachineIdentity = {
  metadata: {
    algorithm: "Ed25519",
    publicKey: "test-key",
    fingerprint: "SHA256:test",
    verificationPhrase: "test-phrase",
    credentialProtectionLevel: "software_protected",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  sign: () => "signature",
};

const pairing: PairingCredential = {
  controlPlaneUrl: "https://fleet.invalid",
  machineId: "machine-1",
  agentToken: "token",
  pairedAt: "2026-01-01T00:00:00.000Z",
  machineName: "test-machine",
};

const support: SupportReport = {
  supported: true,
  writable: true,
  readOnlyReasons: [],
  platform: "linux",
  architecture: "x64",
  osId: "ubuntu",
  osVersion: "24.04",
  uid: 1000,
  nodeVersion: "v24.14.0",
  codexVersion: "0.153.2",
  codexSchemaHash: "test-schema",
  expectedCodexSchemaHash: "test-schema",
};

function countStateReads(store: StateStore): { reads: number } {
  const database = (store as unknown as { database: DatabaseSync }).database;
  const prepare = database.prepare.bind(database);
  const counter = { reads: 0 };
  database.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/^\s*SELECT\b/i.test(sql) && sql.includes("state_json") && !sql.includes("length(state_json)")) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: Parameters<typeof get>) => {
        counter.reads += 1;
        return get(...args);
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof database.prepare;
  return counter;
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("item batches survive a large snapshot without rereading it or replaying a task", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-event-batch-"));
  const store = new StateStore(directory);
  await store.initialize();
  const project: ProjectRecord = {
    id: "project-1", alias: "project", root: directory, device: "1", inode: "1", identityVersion: 1, addedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.addProject(project);
  let callbacks!: AppServerCallbacks;
  const server = {
    appServerEpoch: "epoch-batch",
    async start() {},
    async stop() {},
    async listThreads() { return []; },
    async unsubscribeThread() {},
  } as unknown as AppServerClient;
  const runtime = new AgentRuntime({
    store, identity, pairing, support,
    appServerFactory: (next) => { callbacks = next; return server; },
  });
  t.after(async () => { await runtime.shutdown(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize();
  const thread: ManagedThread = {
    nativeThreadId: "thread-1", projectId: project.id, logicalSessionId: "session-1", executionSegmentId: "segment-1",
    appServerEpoch: "epoch-batch", policyVersion: "native-acp-v1", policyVerified: true, contentEpoch: 1, createdAt: "2026-01-01T00:00:00.000Z",
  };
  await store.setManagedThread(thread);
  await store.appendEvent({
    machineId: pairing.machineId, producerEpoch: runtime.producerEpoch, projectId: project.id,
    logicalSessionId: "session-1", executionSegmentId: "segment-1", nativeThreadId: "thread-1",
    type: "agent.warning", payload: { blob: "x".repeat(10 * 1024 * 1024) },
  });
  const before = store.snapshot().outbox.length;
  await assert.rejects(store.appendThreadEvents("thread-1", [
    { machineId: pairing.machineId, producerEpoch: runtime.producerEpoch, appServerEpoch: "epoch-batch", projectId: project.id, logicalSessionId: "session-1", executionSegmentId: "segment-1", contentEpoch: 1, type: "item.completed", nativeThreadId: "thread-1", nativeTurnId: "turn-1", nativeItemId: "kept", payload: { item: { id: "kept" } } },
    { machineId: pairing.machineId, producerEpoch: "missing-epoch", appServerEpoch: "epoch-batch", projectId: project.id, logicalSessionId: "session-1", executionSegmentId: "segment-1", contentEpoch: 1, type: "item.completed", nativeThreadId: "thread-1", nativeTurnId: "turn-1", nativeItemId: "dropped", payload: { item: { id: "dropped" } } },
  ], "epoch-batch", { cursor: "dropped", count: 2 }));
  assert.equal(store.snapshot().outbox.length, before);
  assert.equal(store.managedThread("thread-1")?.historyCursor, undefined);

  const total = 1000;
  const events: AppEvent[] = Array.from({ length: total }, (_, index) => ({
    type: "item.completed", nativeThreadId: "thread-1", nativeTurnId: "turn-1", nativeItemId: `item-${index}`,
    payload: { item: { id: `item-${index}`, type: "agentMessage", text: `n${index}` } },
  }));
  const reads = countStateReads(store);
  const update = store.update.bind(store);
  let writes = 0;
  store.update = (mutator) => { writes += 1; return update(mutator); };
  let during = false;
  const timer = setInterval(() => {
    const saved = store.managedThread("thread-1")?.historyItemCount ?? 0;
    if (saved > 0 && saved < total) during = true;
  }, 0);
  try { await callbacks.onEvents!(events, "epoch-batch"); }
  finally { clearInterval(timer); }
  assert.equal(during, true);
  assert.equal(writes, Math.ceil(total / 32));
  assert.equal(reads.reads, 0);
  const saved = store.pendingOutbox().filter(event => event.nativeTurnId === "turn-1");
  assert.equal(saved.length, total);
  assert.deepEqual(saved.map(event => event.nativeItemId), events.map(event => event.nativeItemId));
  for (let index = 1; index < saved.length; index += 1) assert.equal(saved[index]!.hostSeq, saved[index - 1]!.hostSeq + 1);
  assert.equal(store.managedThread("thread-1")?.historyCursor, "item-999");
  assert.equal(store.managedThread("thread-1")?.historyItemCount, total);
  assert.equal(Object.keys(store.snapshot().commandJournal).length, 0);

  await callbacks.onEvent({ type: "turn.completed", nativeThreadId: "thread-1", nativeTurnId: "turn-1", payload: { turn: { id: "turn-1", status: "completed" } } }, "epoch-batch");
  const finished = store.pendingOutbox().filter(event => event.nativeTurnId === "turn-1");
  assert.equal(finished.at(-1)?.type, "turn.completed");
  assert.ok(finished.at(-1)!.hostSeq > finished[finished.length - 2]!.hostSeq);
  const sequences = finished.map(event => event.hostSeq);
  const reopened = new StateStore(directory);
  await reopened.initialize();
  t.after(() => reopened.close());
  const restored = reopened.pendingOutbox().filter(event => event.nativeTurnId === "turn-1");
  assert.deepEqual(restored.map(event => event.hostSeq), sequences);
  assert.equal(restored.at(-1)?.type, "turn.completed");
  assert.equal(Object.keys(reopened.snapshot().commandJournal).length, 0);
});

test("outbox drain yields while resending saved records and does not execute a task", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-outbox-yield-"));
  const store = new StateStore(directory);
  await store.initialize();
  await store.beginProducerEpoch("producer-current");
  const project: ProjectRecord = {
    id: "project-local", alias: "project", root: directory, device: "1", inode: "1", identityVersion: 1, addedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.addProject(project);
  const sent: Record<string, unknown>[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>); },
    close() { this.readyState = 3; },
    addEventListener() {},
  };
  const runtime = {
    producerEpoch: "producer-current",
    commandCalls: [] as unknown[],
    callbacks: undefined as { onOutboxChanged(): void } | undefined,
    setCallbacks(callbacks: { onOutboxChanged(): void }) { this.callbacks = callbacks; },
    setTransportGeneration() {},
    getAppServerEpoch: () => "app-current",
    helloPayload: () => ({ type: "hello" }),
    heartbeatPayload: () => ({ type: "heartbeat", capacity: "idle", activeTurns: 0 }),
    async handleCommand(command: unknown) { this.commandCalls.push(command); },
    async advanceContentEpoch() {},
    async refreshQuota() {},
  };
  const relay = new RelayConnection({
    runtime: runtime as unknown as AgentRuntime, store, identity, pairing,
    requestedUrl: "https://fleet.invalid", logger: { info: () => undefined, warn: () => undefined },
  });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const access = relay as unknown as {
    socket: typeof socket; generation: number; helloAcknowledged: boolean;
    projectMappings: Map<string, string>; sentEvents: Set<string>;
  };
  access.socket = socket;
  access.generation = 7;
  access.helloAcknowledged = true;
  access.projectMappings.set(project.id, "server-project");
  const total = 40;
  for (let index = 0; index < total; index += 1) {
    await store.appendEvent({
      machineId: pairing.machineId, producerEpoch: "producer-current", projectId: project.id,
      type: "item.completed", nativeThreadId: "thread-1", nativeTurnId: "turn-1", nativeItemId: `item-${index}`,
      payload: { index },
    });
  }
  let during = false;
  const timer = setInterval(() => { if (sent.length > 0 && sent.length < total) during = true; }, 0);
  try {
    runtime.callbacks!.onOutboxChanged();
    await until(() => sent.length >= total);
  } finally { clearInterval(timer); }
  assert.equal(during, true);
  assert.deepEqual(sent.map(frame => frame.type), Array.from({ length: total }, () => "event.append"));
  assert.deepEqual(sent.map(frame => (frame.event as { nativeItemId: string }).nativeItemId), Array.from({ length: total }, (_, index) => `item-${index}`));
  assert.equal(runtime.commandCalls.length, 0);
  access.sentEvents.clear();
  sent.length = 0;
  runtime.callbacks!.onOutboxChanged();
  await until(() => sent.length >= total);
  assert.equal(sent.length, total);
  assert.ok(sent.every(frame => frame.type === "event.append"));
  assert.equal(runtime.commandCalls.length, 0);
});
