import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuntimeSettings } from "../src/codex-settings.js";

test("live settings have a separate exact-turn binding and cannot inject mode, permissions or credentials", () => {
  const state = parseRuntimeSettings({ accepted: { model: "original", mode: "plan", nativeTurnId: "turn", acceptedAt: "timestamp" }, active: { model: "updated", effort: "high", nativeTurnId: "turn", changedAt: "timestamp", mode: "default", permissionProfile: "full", token: "secret" } });
  assert.deepEqual(state?.accepted, { model: "original", mode: "plan", nativeTurnId: "turn", acceptedAt: "timestamp" });
  assert.deepEqual(state?.active, { model: "updated", effort: "high", nativeTurnId: "turn", changedAt: "timestamp" });
  assert.equal(parseRuntimeSettings({ active: { model: "unbound" } })?.active, undefined);
});
