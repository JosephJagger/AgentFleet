import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_VERSION } from "../src/constants.js";
import { installationStep, agentUpdateDiagnostics, recordUpdateProgress } from "../src/installation.js";
import { readUpdateTransaction, writeUpdateTransaction, type UpdateTransaction } from "../src/supervisor.js";
import { AgentAutoUpdater, eligibleForAgentRollout, retryableUpdateFailure } from "../src/updater.js";

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
