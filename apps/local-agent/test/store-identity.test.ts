import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateIdentity } from "../src/identity.js";
import { StateStore } from "../src/store.js";
import type { FleetCommand } from "../src/types.js";
import { canonicalJson, sha256 } from "../src/util.js";

test("identity is stable, Ed25519, and stored with mode 0600", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-identity-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  const first = await loadOrCreateIdentity(store);
  const keyStat = await stat(store.privateKeyPath);
  assert.equal(keyStat.mode & 0o777, 0o600);
  assert.equal(first.metadata.credentialProtectionLevel, "software_protected");
  assert.match(first.metadata.fingerprint, /^SHA256:(?:[a-f0-9]{4}:){15}[a-f0-9]{4}$/);

  const message = "agentfleet-proof";
  const publicKey = createPublicKey({
    key: Buffer.from(first.metadata.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  assert.equal(verify(null, Buffer.from(message), publicKey, Buffer.from(first.sign(message), "base64url")), true);

  const reopened = new StateStore(directory);
  await reopened.initialize();
  const second = await loadOrCreateIdentity(reopened);
  assert.equal(second.metadata.publicKey, first.metadata.publicKey);
  assert.equal(second.metadata.fingerprint, first.metadata.fingerprint);
  assert.equal((await stat(reopened.statePath)).mode & 0o777, 0o600);
  assert.equal((await readFile(reopened.statePath)).subarray(0, 16).toString("utf8"), "SQLite format 3\0");
});

test("outbox sequences are contiguous per producer epoch and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-store-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  await store.beginProducerEpoch("epoch-a");
  const first = await store.appendEvent({
    machineId: "mach-1",
    producerEpoch: "epoch-a",
    type: "command.result",
    logicalSessionId: "ls-1",
    executionSegmentId: "seg-1",
    projectId: "project-local",
    payload: { state: "claimed" },
  });
  const second = await store.appendEvent({
    machineId: "mach-1",
    producerEpoch: "epoch-a",
    type: "command.result",
    logicalSessionId: "ls-1",
    executionSegmentId: "seg-1",
    projectId: "project-local",
    payload: { state: "responded" },
  });
  assert.deepEqual([first.hostSeq, second.hostSeq], [1, 2]);
  assert.equal(first.payloadHash, sha256(canonicalJson(first.payload)));
  assert.match(first.payloadHash, /^sha256:[a-f0-9]{64}$/);

  const reopened = new StateStore(directory);
  await reopened.initialize();
  const third = await reopened.appendEvent({
    machineId: "mach-1",
    producerEpoch: "epoch-a",
    type: "command.result",
    logicalSessionId: "ls-1",
    executionSegmentId: "seg-1",
    projectId: "project-local",
    payload: { state: "applied" },
  });
  assert.equal(third.hostSeq, 3);
  await reopened.beginProducerEpoch("epoch-b");
  const nextEpoch = await reopened.appendEvent({
    machineId: "mach-1",
    producerEpoch: "epoch-b",
    type: "agent.warning",
    logicalSessionId: "ls-1",
    executionSegmentId: "seg-1",
    projectId: "project-local",
    payload: { code: "TEST" },
  });
  assert.equal(nextEpoch.hostSeq, 1);
  await reopened.acknowledge("epoch-a", 2);
  assert.deepEqual(
    reopened.snapshot().outbox.map((event) => [event.producerEpoch, event.hostSeq]),
    [["epoch-a", 3], ["epoch-b", 1]],
  );
});

function testCommand(attemptId = "attempt-1", commandId = "command-1"): FleetCommand {
  return {
    attemptId,
    commandId,
    type: "turn.start",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    projectId: "project-1",
    logicalSessionId: "session-1",
    executionSegmentId: "segment-1",
    contentEpoch: 1,
    payload: { prompt: "hello" },
    precondition: { expectedActiveTurnId: null },
  };
}

test("durable inbox detects mutation and fails closed from non-terminal state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-inbox-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  const command = testCommand();
  const claimed = await store.claimCommand(command, "sha256:one");
  assert.equal(claimed.isNew, true);
  await store.transitionCommand(command.attemptId, "claimed", "invoking");

  const reopened = new StateStore(directory);
  await reopened.initialize();
  const duplicate = await reopened.claimCommand(command, "sha256:one");
  assert.equal(duplicate.isNew, false);
  assert.equal(duplicate.entry.state, "unknown");
  assert.equal(reopened.snapshot().commandJournal[command.commandId]?.state, "unknown");
  await assert.rejects(
    reopened.claimCommand({ ...command, payload: { prompt: "changed" } }, "sha256:two"),
    /reused with different immutable content/,
  );
});

test("terminal command result replays across attempts and process reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-journal-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  const command = testCommand();
  await store.claimCommand(command, "sha256:stable");
  await store.transitionCommand(command.attemptId, "claimed", "invoking");
  const response = { nativeThreadId: "thread-1", nativeTurnId: "turn-1" };
  await store.transitionCommand(command.attemptId, "invoking", "responded", { response });
  await store.transitionCommand(command.attemptId, "responded", "applied", { response });

  const second = await store.claimCommand({ ...command, attemptId: "attempt-2" }, "sha256:stable");
  assert.equal(second.isNew, false);
  assert.equal(second.entry.state, "applied");
  assert.equal(second.entry.replayedFromAttemptId, command.attemptId);
  assert.deepEqual(second.entry.response, response);

  const reopened = new StateStore(directory);
  await reopened.initialize();
  const third = await reopened.claimCommand({ ...command, attemptId: "attempt-3" }, "sha256:stable");
  assert.equal(third.entry.state, "applied");
  assert.deepEqual(third.entry.response, response);
  await assert.rejects(
    reopened.claimCommand({ ...command, attemptId: "attempt-4", payload: { prompt: "mutated" } }, "sha256:mutated"),
    /command id was reused with different immutable content/,
  );
});

test("project reservation is owner-fenced and uncertainty survives exits and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-reservation-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  const command = testCommand();
  await store.claimCommand(command, "sha256:stable");
  await store.transitionCommand(command.attemptId, "claimed", "invoking");
  const owner = {
    projectId: command.projectId,
    commandId: command.commandId,
    attemptId: command.attemptId,
    envelopeHash: "sha256:stable",
    appServerEpoch: "app-epoch-1",
  };
  await store.reserveProjectCommand(owner);
  await store.handleAppServerExit("app-epoch-1");
  assert.equal(store.snapshot().projectReservations[command.projectId]?.state, "unknown");
  assert.equal(store.snapshot().commandJournal[command.commandId]?.state, "unknown");
  await assert.rejects(store.reserveProjectCommand(owner), /uncertain outcome/);

  const other = testCommand("attempt-other", "command-other");
  await store.claimCommand(other, "sha256:other");
  await assert.rejects(
    store.reserveProjectCommand({ ...owner, commandId: other.commandId, attemptId: other.attemptId, envelopeHash: "sha256:other", appServerEpoch: "app-epoch-2" }),
    /uncertain outcome/,
  );

  const reopened = new StateStore(directory);
  await reopened.initialize();
  await reopened.reconcileInterruptedWork();
  assert.equal(reopened.snapshot().projectReservations[command.projectId]?.state, "unknown");
  await assert.rejects(
    reopened.reserveProjectCommand({ ...owner, commandId: other.commandId, attemptId: other.attemptId, envelopeHash: "sha256:other", appServerEpoch: "app-epoch-3" }),
    /uncertain outcome/,
  );
});

test("a terminal native turn inside the invocation window safely repairs a timed-out turn start", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-late-turn-test-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const command = testCommand(); const envelopeHash = "sha256:late-terminal";
  await store.claimCommand(command, envelopeHash);
  const owner = { projectId: command.projectId, commandId: command.commandId, attemptId: command.attemptId, envelopeHash, appServerEpoch: "app-epoch" };
  await store.reserveProjectCommand(owner);
  await store.transitionCommand(command.attemptId, "claimed", "invoking");
  const milliseconds = Date.now() + 10;
  const prefix = milliseconds.toString(16).padStart(12, "0");
  const nativeTurnId = `${prefix.slice(0,8)}-${prefix.slice(8)}-7abc-8def-0123456789ab`;
  await store.setManagedThread({ nativeThreadId:"native-thread",projectId:command.projectId,logicalSessionId:command.logicalSessionId,executionSegmentId:command.executionSegmentId,
    appServerEpoch:"app-epoch",policyVersion:"remote-restricted-v1",policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString(),lastTurnId:nativeTurnId,lastTurnStatus:"completed" });
  await store.markCommandUnknown(command.attemptId,{code:"APP_SERVER_TIMEOUT",message:"turn/start did not respond in time"});
  assert.equal(store.canSafelyRestart(),false);
  assert.equal(await store.recoverLateTerminalTurn(command.commandId),true);
  const state=store.snapshot();
  assert.equal(state.commandJournal[command.commandId]?.state,"applied");
  assert.deepEqual(state.commandJournal[command.commandId]?.response,{nativeThreadId:"native-thread",nativeTurnId,status:"completed"});
  assert.equal(state.projectReservations[command.projectId],undefined);
  assert.equal(store.canSafelyRestart(),true);
  assert.equal(await store.recoverLateTerminalTurn(command.commandId),false,"terminal repair is idempotent");
});

test("late-turn repair keeps ambiguous or out-of-window evidence frozen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-ambiguous-turn-test-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const command=testCommand();const envelopeHash="sha256:ambiguous";
  await store.claimCommand(command,envelopeHash);
  await store.reserveProjectCommand({projectId:command.projectId,commandId:command.commandId,attemptId:command.attemptId,envelopeHash,appServerEpoch:"epoch"});
  await store.transitionCommand(command.attemptId,"claimed","invoking");
  const old="018cc251-f400-7abc-8def-0123456789ab";
  await store.setManagedThread({nativeThreadId:"old",projectId:command.projectId,appServerEpoch:"epoch",policyVersion:"remote-restricted-v1",policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString(),lastTurnId:old,lastTurnStatus:"completed"});
  await store.markCommandUnknown(command.attemptId,{code:"APP_SERVER_TIMEOUT",message:"timeout"});
  assert.equal(await store.recoverLateTerminalTurn(command.commandId),false);
  assert.equal(store.snapshot().commandJournal[command.commandId]?.state,"unknown");
  assert.equal(store.canSafelyRestart(),false);
});
