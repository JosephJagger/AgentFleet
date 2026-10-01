import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentAutoUpdater, clearCompletedAgentUpdateDrain, compareReleaseVersions, stageAgentUpdate, windowsUpdateRestartScript } from "../src/updater.js";
import { readFileSync } from "node:fs";

test("Windows update handoff retries the background task after the current task exits", () => {
  const script=windowsUpdateRestartScript();
  assert.match(script,/AgentFleet-Background/);
  assert.match(script,/State -ne 'Running'/);
  assert.match(script,/Start-ScheduledTask/);
  assert.match(script,/Start-Sleep -Seconds 5/);
});

test("the Windows installer schedules a handoff that does not depend on the old Agent binary", () => {
  const installer = readFileSync(new URL("../../../../packaging/install.ps1", import.meta.url), "utf8");
  assert.match(installer, /Register-AgentFleetUpdateHandoff/);
  assert.match(installer, /AgentFleet-Update-Handoff/);
  assert.match(installer, /Start-ScheduledTask -TaskName 'AgentFleet-Background'/);
  assert.match(installer, /New-ScheduledTaskTrigger -Once/);
  assert.doesNotMatch(installer, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(installer, /for \(`\$attempt = 0; `\$attempt -lt 60; `\$attempt\+\+\)/);
  assert.match(installer, /state\.phase -in @\('succeeded','rolled_back','failed'\)/);
  assert.match(installer, /task\.State -ne 'Running'/);
  assert.match(installer, /if \(-not `\$worker\)/);
});

test("release comparison is numeric and rejects non-release versions", () => {
  assert.equal(compareReleaseVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareReleaseVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareReleaseVersions("1.2.2", "1.2.3"), -1);
  assert.throws(() => compareReleaseVersions("latest", "1.2.3"), /invalid AgentFleet release version/);
});

test("automatic updater stages a newer same-origin release", async () => {
  const requests: string[] = [];
  const staged: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("manifest.json")) {
      return new Response(JSON.stringify({ schemaVersion: 1, version: "0.10.0" }));
    }
    return new Response("#!/bin/sh\nexit 0\n");
  };
  const updater = new AgentAutoUpdater({
    currentVersion: "0.9.0",
    controlPlaneUrl: "https://fleet.example/",
    dataDir: "/tmp/agentfleet",
    canUpdate: () => true,
    onStaged: (version) => staged.push(version),
    logger: { info: () => undefined, warn: () => undefined },
    fetchImpl,
    stageUpdate: async (options) => {
      assert.equal(options.controlPlaneUrl, "https://fleet.example");
      assert.equal(options.dataDir, "/tmp/agentfleet");
      assert.match(options.installer, /^#!\/bin\/sh/);
    },
  });
  assert.equal(await updater.checkNow(), "staged");
  assert.deepEqual(requests, [
    "https://fleet.example/downloads/manifest.json",
    "https://fleet.example/install",
  ]);
  assert.deepEqual(staged, ["0.10.0"]);
});

test("automatic updater waits while a managed turn is active", async () => {
  let requestCount = 0;
  const updater = new AgentAutoUpdater({
    currentVersion: "0.9.0",
    controlPlaneUrl: "https://fleet.example",
    dataDir: "/tmp/agentfleet",
    canUpdate: () => false,
    onStaged: () => assert.fail("busy agent must not stage an update"),
    logger: { info: () => undefined, warn: () => undefined },
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ schemaVersion: 1, version: "0.10.0" }));
    },
    stageUpdate: async () => assert.fail("busy agent must not run the installer"),
  });
  assert.equal(await updater.checkNow(), "busy");
  assert.equal(requestCount, 1);
});

test("concurrent update requests share one check and recheck idle before activation", async () => {
  let idle = true;
  let downloads = 0;
  const updater = new AgentAutoUpdater({
    currentVersion: "0.16.2", controlPlaneUrl: "https://fleet.example", dataDir: "/tmp/agentfleet",
    canUpdate: () => idle, onStaged: () => assert.fail("new work prevents activation"),
    logger: { info: () => undefined, warn: () => undefined },
    fetchImpl: async (input) => {
      downloads += 1;
      if (String(input).endsWith("manifest.json")) return new Response(JSON.stringify({ schemaVersion: 1, version: "0.17.0" }));
      idle = false;
      return new Response("#!/bin/sh\nexit 0\n");
    },
    stageUpdate: async () => assert.fail("must recheck idle after downloading the installer"),
  });
  assert.deepEqual(await Promise.all([updater.checkNow(), updater.checkNow()]), ["busy", "busy"]);
  assert.equal(downloads, 2);
});

test("staging invokes the installer in stage-only mode with structured arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-updater-test-"));
  await mkdir(join(directory, "state"));
  await stageAgentUpdate({
    installer: "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$5/update-args\"\n",
    controlPlaneUrl: "https://fleet.example",
    dataDir: join(directory, "state"),
  });
  assert.deepEqual((await readFile(join(directory, "state", "update-args"), "utf8")).trim().split("\n"), [
    "--stage-only",
    "--url",
    "https://fleet.example",
    "--data-dir",
    join(directory, "state"),
  ]);
});


test("startup clears only completed agent update drains, independent of an older runtime transaction", async t => {
  const { StateStore } = await import("../src/store.js");
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-completed-drain-"));
  const store = new StateStore(directory); await store.initialize(); t.after(() => store.close());
  for (const operationId of ["agent-update-0.30.55", "agent-update-0.30.54"]) {
    await store.setMaintenanceDrain(operationId);
    await clearCompletedAgentUpdateDrain(store,"0.30.55");
    assert.equal(store.snapshot().maintenanceDrain,undefined);
  }
  for (const operationId of ["agent-update-0.30.56", "runtime-update-newer", "manual-maintenance", "agent-update-invalid"]) {
    await store.setMaintenanceDrain(operationId);
    await clearCompletedAgentUpdateDrain(store,"0.30.55");
    assert.equal(store.snapshot().maintenanceDrain?.operationId,operationId);
    await store.setMaintenanceDrain(undefined);
  }
});

test("a staged update is not installed again while waiting for the worker to exit",async()=>{
  let installations=0,restarts=0,requests=0;
  const updater=new AgentAutoUpdater({currentVersion:"0.30.65",controlPlaneUrl:"https://fleet.example",dataDir:"/tmp/agentfleet",
    canUpdate:()=>true,onStaged:()=>{restarts++;},logger:{info(){},warn(){}},
    fetchImpl:async input=>{requests++;return new Response(String(input).endsWith("manifest.json")?JSON.stringify({schemaVersion:1,version:"0.30.66"}):"#!/bin/sh\nexit 0\n");},
    stageUpdate:async()=>{installations++;},
  });
  assert.equal(await updater.checkNow(),"staged");
  assert.deepEqual(await Promise.all([updater.checkNow(),updater.checkNow()]),["staged","staged"]);
  assert.equal(installations,1);assert.equal(restarts,1);assert.equal(requests,2);
});
