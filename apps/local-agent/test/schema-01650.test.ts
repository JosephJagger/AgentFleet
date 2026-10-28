import assert from "node:assert/strict";
import test from "node:test";
import { expectedCodexSchemaHash } from "../src/constants.js";
import { parseManagedRuntimeTarget } from "../src/managed-runtime-update.js";

test("0.165.0 managed updates require the reviewed schema and retain rollback", () => {
  const hash = "38027ec8a6fffc2422b674cab13dc1a05c26e13a48349c46a274609d52090e35";
  const previousHash = "705a08b903fecb9457a6c888040b16ff20be4bc74682ee3896c61cb27ce43060";
  const target = { schemaVersion: 1, revision: "12345678-1234-1234-1234-123456789abc", version: "0.165.0", schemaHash: hash, artifacts: {} };
  assert.equal(expectedCodexSchemaHash(target.version), hash);
  assert.equal(parseManagedRuntimeTarget(target)!.version, target.version);
  assert.throws(() => parseManagedRuntimeTarget({ ...target, schemaHash: previousHash }));
  for (const version of ["0.165.1", "0.165.0-alpha.1", "0.166.0"]) {
    assert.throws(() => parseManagedRuntimeTarget({ ...target, version }));
  }
  const rollback = parseManagedRuntimeTarget({ ...target, version: "0.164.0", schemaHash: previousHash, rollback: true });
  assert.equal(rollback!.version, "0.164.0");
  assert.equal(rollback!.rollback, true);
});
