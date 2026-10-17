import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseManagedRuntimeTarget } from "../src/managed-runtime-update.js";
import { REQUIRED_CODEX_SCHEMA_HASH } from "../src/constants.js";
import { AgentAutoUpdater } from "../src/updater.js";
import { StateStore } from "../src/store.js";
import { writeUpdateTransaction } from "../src/supervisor.js";
const target = () => ({ schemaVersion: 1, revision: randomUUID(), version: "0.153.4", schemaHash: REQUIRED_CODEX_SCHEMA_HASH, artifacts: { "linux-x64": { file: `codex-linux-x64-0.153.4-${"a".repeat(16)}`, sha256: "a".repeat(64), size: 100, format: "raw" } } });
test("managed targets reject schema changes, path injection, invalid hashes and previews", () => {
  assert.equal(parseManagedRuntimeTarget(target())?.version, "0.153.4");
  assert.equal(parseManagedRuntimeTarget(null), null);
  const helper = { file: `codex-bwrap-linux-x64-0.153.4-${"b".repeat(16)}`, sha256: "b".repeat(64), size: 300_000, format: "raw" };
  assert.equal(parseManagedRuntimeTarget({ ...target(), sandboxHelper: helper })?.sandboxHelper?.sha256, helper.sha256);
  for (const sandboxHelper of [null, { ...helper, file: "../../bwrap" }, { ...helper, size: 1024 * 1024 + 1 }, { ...helper, sha256: "wrong" }]) assert.throws(() => parseManagedRuntimeTarget({ ...target(), sandboxHelper }));
  for (const value of [{ ...target(), schemaHash: "b".repeat(64) }, { ...target(), version: "0.154.0-alpha" }, { ...target(), rollback: "true" }, { ...target(), artifacts: { "linux-x64": { ...target().artifacts["linux-x64"], file: "../../codex" } } }]) assert.throws(() => parseManagedRuntimeTarget(value));
});
test("same Agent release still checks managed targets, waits for idle and preserves self-installed Codex", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-updater-")); const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const requests: string[] = [];
  const options = { currentVersion: "0.21.0", controlPlaneUrl: "https://fleet.example", dataDir: directory, store, runtimeSource: "managed" as const, currentRuntimeVersion: "0.153.2", canUpdate: () => false, onStaged: () => assert.fail("busy host cannot stage"), logger: { info() {}, warn() {} },
    fetchImpl: async (input: string | URL | Request) => { requests.push(String(input)); return new Response(JSON.stringify(String(input).endsWith("manifest.json") ? { schemaVersion: 1, version: "0.21.0" } : { target: target() })); },
    prepareRuntime: async () => async () => { assert.fail("busy host must not activate a runtime"); } };
  assert.equal(await new AgentAutoUpdater(options).checkNow(), "busy"); assert.equal(requests.length, 2); assert.equal(store.snapshot().maintenanceDrain, undefined);
  requests.length = 0;
  assert.equal(await new AgentAutoUpdater({ ...options, runtimeSource: "host" }).checkNow(), "current"); assert.equal(requests.length, 1);
  assert.equal(await new AgentAutoUpdater({ ...options, currentRuntimeVersion: "0.153.4" }).checkNow(), "current");
  assert.equal(store.snapshot().maintenanceDrain, undefined, "withdrawn/already-current target releases an old automatic drain");
  assert.equal(await new AgentAutoUpdater({ ...options, currentRuntimeVersion: "0.153.4", needsRuntimeRepair: () => true }).checkNow(), "busy", "missing execution tools allow same-version repair, but still wait for idle");
});
test("failed runtime revision is not retried and download verification failure clears maintenance drain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-updater-")); const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const release = target();
  await writeUpdateTransaction(directory, { updateId: randomUUID(), phase: "rolled_back", previousVersion: "0.21.0", targetVersion: "0.21.0", targetRuntimeRevision: release.revision, targetRuntimeVersion: release.version, backupDir: join(directory, "updates", "test"), launcher: "test", previousTarget: "test", profilePresent: true, codexPresent: true, startedAt: new Date().toISOString() });
  const options = { currentVersion: "0.21.0", controlPlaneUrl: "https://fleet.example", dataDir: directory, store, runtimeSource: "managed" as const, currentRuntimeVersion: "0.153.2", canUpdate: () => true, onStaged: () => assert.fail("failed validation cannot stage"), logger: { info() {}, warn() {} },
    fetchImpl: async (input: string | URL | Request) => new Response(JSON.stringify(String(input).endsWith("manifest.json") ? { schemaVersion: 1, version: "0.21.0" } : { target: release })),
    prepareRuntime: async () => { throw new Error("checksum mismatch"); } };
  await assert.rejects(new AgentAutoUpdater(options).checkNow(), /失败并已回退/);
  release.revision = randomUUID();
  await assert.rejects(new AgentAutoUpdater(options).checkNow(), /checksum mismatch/);
  assert.equal(store.snapshot().maintenanceDrain, undefined);
});

test("Agent rollout deferral does not hide a reviewed Codex update", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-rollout-")); const store = new StateStore(dir); await store.initialize();
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  let prepared = 0;
  const updater = new AgentAutoUpdater({currentVersion:"1.0.0",controlPlaneUrl:"https://fleet.example",dataDir:dir,store,
    runtimeSource:"managed",currentRuntimeVersion:"0.153.2",canUpdate:()=>false,onStaged:()=>assert.fail("busy"),logger:{info(){},warn(){}},
    fetchImpl:async input=>new Response(JSON.stringify(String(input).endsWith("manifest.json")?{schemaVersion:1,version:"1.1.0",rollout:{percentage:0,seed:"test"}}:{target:target()})),
    prepareRuntime:async()=>{prepared++;return async()=>assert.fail("busy");}});
  assert.equal(await updater.checkNow(),"busy"); assert.equal(prepared,1);
  assert.equal(store.snapshot().maintenanceDrain,undefined);
});

test("withdrawn runtime target never activates a prepared candidate", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-withdrawn-")); const store = new StateStore(dir); await store.initialize();
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  let prepared = false; const release=target();
  const updater = new AgentAutoUpdater({currentVersion:"1.0.0",controlPlaneUrl:"https://fleet.example",dataDir:dir,store,
    runtimeSource:"managed",currentRuntimeVersion:"0.153.2",canUpdate:()=>true,onStaged:()=>assert.fail("withdrawn"),logger:{info(){},warn(){}},
    fetchImpl:async input=>new Response(JSON.stringify(String(input).endsWith("manifest.json")?{schemaVersion:1,version:"1.0.0"}:{target:prepared?null:release})),
    prepareRuntime:async()=>{prepared=true;return async()=>assert.fail("withdrawn");}});
  assert.equal(await updater.checkNow(),"deferred");
  assert.equal(store.snapshot().maintenanceDrain,undefined);
});
test("forward runtime upgrades wait for user confirmation; repairs and rollbacks do not", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-confirm-")); const store = new StateStore(dir); await store.initialize();
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  const release = target(); const phases: string[] = []; let prepared = 0, activated = 0, staged = 0, body: object = {target: release};
  const options = {currentVersion:"1.0.0",controlPlaneUrl:"https://fleet.example",dataDir:dir,store,runtimeSource:"managed" as const,currentRuntimeVersion:"0.153.2",canUpdate:()=>true,
    confirmRuntimeUpgrade:true,onStaged:()=>{staged++;},logger:{info(){},warn(){}},onRuntimePhase:(phase:string)=>{phases.push(phase);},
    fetchImpl:async (input: string | URL | Request) => new Response(JSON.stringify(String(input).endsWith("manifest.json")?{schemaVersion:1,version:"1.0.0"}:body)),
    prepareRuntime:async()=>{prepared++;return async()=>{activated++;};}};
  const updater = new AgentAutoUpdater(options);
  assert.equal(await updater.checkNow(), "current"); assert.deepEqual([prepared, activated, staged], [0, 0, 0], "nothing is downloaded or switched before approval");
  assert.equal(phases.at(-1), "awaiting_confirmation");
  await assert.rejects(updater.confirmRuntime("0.153.3"), /已变化/, "only the offered version can be approved");
  await assert.rejects(updater.confirmRuntime("latest"), /已变化/);
  assert.equal(store.snapshot().confirmedRuntimeVersion, undefined);
  await updater.confirmRuntime("0.153.4");
  assert.equal(store.snapshot().confirmedRuntimeVersion, "0.153.4");
  for (let i = 0; i < 100 && !staged; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([prepared, activated, staged], [1, 1, 1], "approval applies the verified runtime");
  assert.equal(store.snapshot().confirmedRuntimeVersion, undefined, "the approval is consumed after activation");
  // A rollback target and a same-version repair never wait for approval.
  const rollbackBody = {target: {...target(), rollback: true, version: "0.153.2", artifacts: {"linux-x64": {file: `codex-linux-x64-0.153.2-${"a".repeat(16)}`, sha256: "a".repeat(64), size: 100, format: "raw"}}}};
  body = rollbackBody; prepared = 0; staged = 0;
  assert.notEqual(await new AgentAutoUpdater({...options, currentRuntimeVersion: "0.153.4"}).checkNow(), "x");
  assert.equal(prepared, 1, "rollbacks apply without waiting");
  body = {target: release}; prepared = 0;
  assert.equal(await new AgentAutoUpdater({...options, currentRuntimeVersion: "0.153.4", needsRuntimeRepair: () => true}).checkNow() !== undefined, true);
  assert.equal(prepared, 1, "repairing a broken runtime is not gated");
});
test("the confirmation gate is off unless enabled, preserving the previous automatic behaviour", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-auto-")); const store = new StateStore(dir); await store.initialize();
  t.after(async () => { store.close(); await rm(dir, {recursive:true,force:true}); });
  let prepared = 0;
  const updater = new AgentAutoUpdater({currentVersion:"1.0.0",controlPlaneUrl:"https://fleet.example",dataDir:dir,store,runtimeSource:"managed",currentRuntimeVersion:"0.153.2",canUpdate:()=>true,onStaged:()=>{},logger:{info(){},warn(){}},
    fetchImpl:async input=>new Response(JSON.stringify(String(input).endsWith("manifest.json")?{schemaVersion:1,version:"1.0.0"}:{target:target()})),
    prepareRuntime:async()=>{prepared++;return async()=>{};}});
  await updater.checkNow(); assert.equal(prepared, 1);
});
