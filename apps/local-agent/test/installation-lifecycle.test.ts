import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_VERSION } from "../src/constants.js";
import { installationStep, agentUpdateDiagnostics, recordUpdateProgress } from "../src/installation.js";
import { readUpdateTransaction, writeUpdateTransaction, type UpdateTransaction } from "../src/supervisor.js";
import { AgentAutoUpdater, eligibleForAgentRollout, retryableUpdateFailure } from "../src/updater.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("the downloaded installer admits a legacy claim history timeout without clearing its receipt, but blocks tasks", async t => {
  const dir = await mkdtemp(join(tmpdir(), "claim-installer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Isolate the simulated home in a child; never touch the real service launcher.
  const script = `
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdir, symlink } from 'node:fs/promises';
    import { join } from 'node:path';
    os.homedir = () => process.argv[1]; syncBuiltinESMExports();
    const { StateStore } = await import(${JSON.stringify(new URL("../src/store.js", import.meta.url).href)});
    const { installationStep } = await import(${JSON.stringify(new URL("../src/installation.js", import.meta.url).href)});
    const { readUpdateTransaction } = await import(${JSON.stringify(new URL("../src/supervisor.js", import.meta.url).href)});
    await mkdir(join(os.homedir(), '.local/bin'), { recursive: true });
    const oldTarget = join(os.homedir(), '.local/share/agentfleet/bin/0.30.153/agentfleet');
    await symlink(oldTarget, join(os.homedir(), '.local/bin/agentfleet'));
    for (const variant of ['history-claim', 'unknown-task', 'active-task', 'voice']) {
      const dataDir = join(os.homedir(), variant);
      const store = new StateStore(dataDir); await store.initialize();
      const error = { code: 'APP_SERVER_TIMEOUT', message: 'thread/items/list did not respond in time' };
      const request = { attemptId: 'attempt', commandId: 'command', type: variant === 'unknown-task' ? 'turn.start' : 'thread.claim',
        projectId: 'project', logicalSessionId: 'session', executionSegmentId: 'segment', contentEpoch: 1,
        payload: {}, precondition: {}, transportGeneration: 1, appServerEpoch: 'old', expiresAt: new Date(Date.now() + 60000).toISOString() };
      await store.claimCommand(request, 'hash');
      await store.reserveProjectCommand({ projectId: 'project', commandId: 'command', attemptId: 'attempt', envelopeHash: 'hash', appServerEpoch: 'old' });
      await store.transitionCommand('attempt', 'claimed', 'invoking');
      await store.markCommandUnknown('attempt', error);
      if (variant === 'active-task') await store.setManagedThread({ nativeThreadId: 'native', projectId: 'project', appServerEpoch: 'old', activeTurnId: 'running', createdAt: new Date().toISOString() });
      if (variant === 'voice') await store.setPanelVoiceRuntime({ voiceId: 'voice', pid: process.pid });
      if (variant === 'history-claim') {
        await installationStep(dataDir, 'prepare');
        assert.equal((await readUpdateTransaction(dataDir)).phase, 'preparing');
        assert.ok(store.snapshot().maintenanceDrain);
      } else {
        await assert.rejects(installationStep(dataDir, 'prepare'), { code: 'UPDATE_HOST_BUSY' });
        assert.equal(await readUpdateTransaction(dataDir), undefined);
        assert.equal(store.snapshot().maintenanceDrain, undefined);
      }
      assert.equal(store.snapshot().commandJournal.command.state, 'unknown');
      assert.deepEqual(store.snapshot().commandJournal.command.error, error);
      assert.ok(store.snapshot().projectReservations.project);
      store.close();
    }
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, dir]);
});

test("an interrupted activation remains durable and cannot be mistaken for a healthy install", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activation-state-")); t.after(() => rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,"updates/backup"),{recursive:true});
  const tx: UpdateTransaction = {updateId:"activation-test",phase:"preparing",previousVersion:"0.30.80",targetVersion:AGENT_VERSION,
    backupDir:join(dir,"updates/backup"),launcher:"unused",previousTarget:"unused",profilePresent:false,codexPresent:false,startedAt:new Date().toISOString()};
  await writeUpdateTransaction(dir,tx);
  await installationStep(dir,"staged");
  assert.equal((await readUpdateTransaction(dir))?.phase,"staged");
  await assert.rejects(installationStep(dir,"staged"),{code:"UPDATE_PHASE_CHANGED"});
  const diagnostics = await agentUpdateDiagnostics(dir);
  assert.equal(diagnostics.agentUpdateState,"staged"); assert.equal(diagnostics.agentRunningVersion,AGENT_VERSION);
  assert.equal(diagnostics.agentUpdateVerifiedAt,"");
  await writeUpdateTransaction(dir,{...tx,phase:"verifying"});
  await writeUpdateTransaction(dir,{...tx,phase:"succeeded",verifiedAt:new Date().toISOString()});
  await installationStep(dir,"wait");
  await writeUpdateTransaction(dir,{...tx,updateId:"failed-second-activation",phase:"preparing"});
  await writeUpdateTransaction(dir,{...tx,updateId:"failed-second-activation",phase:"rolled_back",rollbackVerifiedAt:new Date().toISOString(),error:"startup failed"});
  await assert.rejects(installationStep(dir,"wait"),{code:"UPDATE_ROLLED_BACK"});
  await assert.rejects(writeUpdateTransaction(dir,{...tx,updateId:"failed-second-activation",phase:"succeeded"}),{code:"UPDATE_PHASE_CHANGED"});
  assert.equal((await readUpdateTransaction(dir))?.phase,"rolled_back");
});

test("new download progress is persisted independently from the last successful activation", async t => {
  const dir = await mkdtemp(join(tmpdir(),"update-progress-")); t.after(() => rm(dir,{recursive:true,force:true}));
  await recordUpdateProgress(dir,"downloading","0.99.0");
  assert.equal((await agentUpdateDiagnostics(dir)).agentUpdateState,"downloading");
  await recordUpdateProgress(dir,"failed","0.99.0","network disconnected");
  const result = await agentUpdateDiagnostics(dir);
  assert.equal(result.agentUpdateError,"network disconnected");
  assert.equal(JSON.parse(await readFile(join(dir,"update-progress.json"),"utf8")).targetVersion,"0.99.0");
});

test("prepare may download during a task but activation waits and binds the exact prepared version", async () => {
  let idle=false, prepared=0, activated=0;
  const updater = new AgentAutoUpdater({currentVersion:"0.1.0",controlPlaneUrl:"https://fleet.example",dataDir:"unused",
    canUpdate:()=>idle,onStaged:()=>{},logger:{info:()=>{},warn:()=>{}},
    fetchImpl:async input => new Response(String(input).endsWith("manifest.json")?JSON.stringify({schemaVersion:1,version:"0.2.0"}):(process.platform==="win32"?"param()\nexit 0\n":"#!/bin/sh\nexit 0\n")),
    prepareUpdate:async options=>{assert.equal(options.prepareOnly,true);assert.equal(options.expectedVersion,"0.2.0");prepared++;},
    stageUpdate:async options=>{assert.equal(idle,true);assert.equal(options.expectedVersion,"0.2.0");activated++;},
  });
  assert.equal(await updater.checkNow(),"busy");assert.equal(prepared,1);assert.equal(activated,0);
  assert.equal(await updater.checkNow(),"busy");assert.equal(prepared,1);
  idle=true;assert.equal(await updater.checkNow(),"staged");assert.equal(activated,1);
});

test("rollout cohorts are stable, platform-scoped, pausable, and reject invalid policy", () => {
  const policy = (percentage: number) => JSON.stringify({rollout:{percentage,seed:"release-test",platforms:["darwin-arm64"]}});
  assert.equal(eligibleForAgentRollout(policy(100),"host","linux-x64"),false);
  assert.equal(eligibleForAgentRollout(policy(100),"host","darwin-arm64"),true);
  assert.equal(eligibleForAgentRollout(policy(0),"host","darwin-arm64"),false);
  assert.equal(eligibleForAgentRollout(policy(10),"host","darwin-arm64"),eligibleForAgentRollout(policy(10),"host","darwin-arm64"));
  assert.throws(()=>eligibleForAgentRollout(policy(101),"host","darwin-arm64"),{code:"UPDATE_ROLLOUT_INVALID"});
  assert.equal(eligibleForAgentRollout("{}"),true);
});

test("temporary transport failures may retry but corrupted or incompatible releases never do", () => {
  assert.equal(retryableUpdateFailure("UPDATE_INSTALL_TIMEOUT","installer timed out"),true);
  assert.equal(retryableUpdateFailure("UPDATE_INSTALL_FAILED","curl: (56) connection reset"),true);
  assert.equal(retryableUpdateFailure("UPDATE_INSTALL_FAILED","SHA-256 mismatch after connection reset"),false);
  assert.equal(retryableUpdateFailure("UPDATE_INSTALL_FAILED","schema mismatch"),false);
  assert.equal(retryableUpdateFailure("UPDATE_INSTALL_FAILED","permission denied"),false);
});

test("late progress cannot overwrite a matching terminal health receipt", async t => {
  const dir = await mkdtemp(join(tmpdir(), "update-receipt-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const tx: UpdateTransaction = { updateId: "receipt", phase: "preparing", previousVersion: "0.1.0", targetVersion: AGENT_VERSION,
    backupDir: join(dir, "updates", "backup"), launcher: "unused", previousTarget: "unused", profilePresent: false, codexPresent: false, startedAt: new Date().toISOString() };
  await writeUpdateTransaction(dir, tx);
  await writeUpdateTransaction(dir, { ...tx, phase: "staged" });
  await writeUpdateTransaction(dir, { ...tx, phase: "verifying" });
  await writeUpdateTransaction(dir, { ...tx, phase: "succeeded", verifiedAt: new Date().toISOString() });
  await recordUpdateProgress(dir, "restarting", AGENT_VERSION);
  assert.equal((await agentUpdateDiagnostics(dir)).agentUpdateState, "succeeded");
  await new Promise(resolve => setTimeout(resolve, 5));
  await recordUpdateProgress(dir, "downloading", "99.0.0");
  const next = await agentUpdateDiagnostics(dir);
  assert.equal(next.agentUpdateState, "downloading");
  assert.equal(next.agentUpdateVerifiedAt, "", "old health proof must not certify a new target");
});

test("running a target without its health receipt is pending verification, not still restarting or successful", async t => {
  const dir = await mkdtemp(join(tmpdir(), "update-pending-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await recordUpdateProgress(dir, "restarting", AGENT_VERSION);
  assert.equal((await agentUpdateDiagnostics(dir)).agentUpdateState, "verification_pending");
});
