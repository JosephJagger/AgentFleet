import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/store.js";
import { assertAcpUnoccupied, registerCursorWorkerPersistence, retainReleasedCursorWorkers } from "../src/acp-providers.js";

test("released Cursor workers retain exact identity across store/runtime restarts; unrelated and reused PIDs remain blocked", async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-worker-proof-"));
  const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  // No native CLI is spawned. PID 1 is only checked for existence (signal 0).
  const args = "/fixture/cursor-agent/versions/test/node /fixture/cursor-agent/versions/test/index.js";
  let rows = [{ pid: 123456, ppid: 0, exe: "node", args: `${args} acp` }, { pid: 1, ppid: 123456, exe: "node", args: `${args} worker-server` }];
  let token = "original-start-token";
  const inspection = { rows: async () => rows, startToken: async () => token };
  const bind = (owned: Set<number>) => registerCursorWorkerPersistence(owned, {
    read: () => store.snapshot().releasedCursorWorkers ?? [], write: records => store.saveReleasedCursorWorkers(records),
  });
  const owned = new Set([123456]); bind(owned);
  await retainReleasedCursorWorkers(owned, 123456, inspection);
  assert.equal(store.snapshot().releasedCursorWorkers?.length, 1);
  store.close(); await store.initialize();
  rows = [{ pid: 1, ppid: 0, exe: "node", args: `${args} worker-server` }];
  const restarted = new Set<number>(); bind(restarted);
  await assertAcpUnoccupied("cursor", restarted, inspection);
  token = "reused-pid-token";
  await assert.rejects(assertAcpUnoccupied("cursor", restarted, inspection), { code: "PROVIDER_NATIVE_BUSY" });
  token = "original-start-token";
  rows[0]!.args = `${args} acp`;
  await assert.rejects(assertAcpUnoccupied("cursor", restarted, inspection), { code: "PROVIDER_NATIVE_BUSY" });
  rows[0]!.args = `${args} worker-server`;
  await assert.rejects(assertAcpUnoccupied("cursor", new Set(), inspection), { code: "PROVIDER_NATIVE_BUSY" });
});
