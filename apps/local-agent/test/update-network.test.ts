import assert from "node:assert/strict";
import test from "node:test";
import { retryUpdateDownload } from "../src/update-network.js";
import { expectedCodexSchemaHash } from "../src/constants.js";
import { readFile } from "node:fs/promises";

test("reviewed schemas match the control plane; unknown versions fail closed", async () => {
  assert.equal(expectedCodexSchemaHash("0.156.0"), "995fc3b8f8c469f6787e8fc5be4038c4f31359025edd8480b862e83355f3bf3b");
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
