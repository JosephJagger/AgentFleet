import assert from "node:assert/strict";
import test from "node:test";
import { retryUpdateDownload } from "../src/update-network.js";
import { expectedCodexSchemaHash } from "../src/constants.js";
import { readFile } from "node:fs/promises";

test("reviewed schemas match the control plane; unknown versions fail closed", async () => {
  assert.equal(expectedCodexSchemaHash("0.156.0"), "995fc3b8f8c469f6787e8fc5be4038c4f31359025edd8480b862e83355f3bf3b");
  assert.equal(expectedCodexSchemaHash("0.159.2"), "81a88c04ae4984b16d73080f4109d0477682bc76c8adbe483e371175ce54c054");
  assert.equal(expectedCodexSchemaHash("0.159.0"), "81a88c04ae4984b16d73080f4109d0477682bc76c8adbe483e371175ce54c054");
  assert.equal(expectedCodexSchemaHash("0.158.0"), "5742a9a7dd41a8b44dca3138f506e013620d4a93573c792b1e5881c053f169a7");
  assert.equal(expectedCodexSchemaHash("0.162.1"), "0bf5254bede109d4ae03ce2e81372e4c93a30b359c0749ec7dce7a9382a7f857");
  assert.equal(expectedCodexSchemaHash("0.162.2"), "unreviewed");
  assert.equal(expectedCodexSchemaHash("0.157.0"), "unreviewed");
  assert.equal(await readFile(new URL("../../src/reviewed-codex-schemas.ts", import.meta.url), "utf8"), await readFile(new URL("../../../control-plane/src/reviewed-codex-schemas.ts", import.meta.url), "utf8"));
});
test("transient download failures retry but integrity failures do not", async () => {
  let count = 0;
  assert.equal(await retryUpdateDownload(async () => { if (++count < 3) throw new TypeError("fetch failed"); return "verified"; }), "verified");
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(retryUpdateDownload(async () => { count++; throw new Error("checksum mismatch"); }), /checksum/);
  assert.equal(count, 1);
});
test("cancelled downloads never retry", async () => {
  const abort = new AbortController(); let count = 0;
  await assert.rejects(retryUpdateDownload(async () => { count++; abort.abort(); throw new TypeError("fetch failed"); }, abort.signal));
  assert.equal(count, 1);
});

test("temporary HTTP failures retry; authentication failures remain visible", async () => {
  let calls=0;
  const result=await retryUpdateDownload(async()=>new Response("",{status:++calls<3?503:200}));
  assert.equal(result.status,200); assert.equal(calls,3);
  calls=0;
  const denied=await retryUpdateDownload(async()=>{calls++;return new Response("",{status:403});});
  assert.equal(denied.status,403); assert.equal(calls,1);
});
