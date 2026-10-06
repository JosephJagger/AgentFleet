import test from "node:test";
import assert from "node:assert/strict";
import { parseModels, validateSettings, turnSettingsParams, readObservedSettings, settingsAfterPlan, resolveTurnMode, type CodexCatalog } from "../src/codex-settings.js";

const catalog: CodexCatalog = { models: [{ model: "model-a", displayName: "A", efforts: ["low", "high"], defaultEffort: "low" }], modes: ["default", "plan"], fetchedAt: new Date().toISOString() };
test("service tier and personality are capability-gated typed parameters, including explicit reset", () => {
  const models = parseModels({ data: [{ model: "model-a", supportedReasoningEfforts: [], serviceTiers: [{ id: "fast", name: "Fast", secret: "omit" }], supportsPersonality: true }] });
  assert.deepEqual(models[0]?.serviceTiers, [{ id: "fast", name: "Fast" }]);
  const capable = { ...catalog, models };
  const settings = { model: "model-a", serviceTier: "fast", personality: "pragmatic" } as const;
  assert.deepEqual(turnSettingsParams(validateSettings(settings, capable)), settings);
  assert.deepEqual(turnSettingsParams(validateSettings({ model: "model-a", serviceTier: null }, capable)), { model: "model-a", serviceTier: null });
  for (const value of [settings, { model: "model-a", personality: "friendly" }, { model: "model-a", serviceTier: "invented" }]) assert.throws(() => validateSettings(value, catalog));
  assert.throws(() => validateSettings({ model: "model-a", personality: "invented" }, capable));
});
test("only host-advertised models, effort and modes can be selected", () => {
  assert.deepEqual(validateSettings({ model: "model-a", effort: "high", mode: "plan" }, catalog), { model: "model-a", effort: "high", mode: "plan" });
  for (const value of [{ model: "other-host-model" }, { model: "model-a", effort: "ultra" }, { model: "model-a", mode: "other" }, { model: "model-a", config: { sandbox_mode: "danger-full-access" } }]) assert.throws(() => validateSettings(value, catalog));
  assert.throws(() => validateSettings({ model: "model-a" }, undefined));
  assert.throws(() => validateSettings({ model: "model-a", mode: "plan" }, { ...catalog, modes: [] }));
  assert.equal(validateSettings(undefined, undefined), undefined);
});
test("plan uses typed collaborationMode, never a text prompt or arbitrary instructions", () => {
  assert.deepEqual(turnSettingsParams({ model: "model-a", effort: "high", mode: "plan" }), {
    model: "model-a", effort: "high", collaborationMode: { mode: "plan", settings: { model: "model-a", reasoning_effort: "high", developer_instructions: null } },
  });
  assert.deepEqual(turnSettingsParams(undefined), {});
  assert.deepEqual(turnSettingsParams({ model: "model-a" }), { model: "model-a" });
});
test("a one-turn plan is explicitly reset on the next turn without overriding a saved plan", () => {
  const previous = { model: "model-a", effort: "high", mode: "plan" } as const;
  const reset = settingsAfterPlan(undefined, previous, catalog);
  assert.deepEqual(reset, { model: "model-a", effort: "high", mode: "default" });
  assert.equal((turnSettingsParams(reset).collaborationMode as { mode: string }).mode, "default");
  assert.deepEqual(settingsAfterPlan({ model: "model-a", effort: "low" }, previous, catalog), { model: "model-a", effort: "low", mode: "default" });
  assert.deepEqual(settingsAfterPlan({ model: "model-a", mode: "plan" }, previous, catalog), { model: "model-a", mode: "plan" });
  assert.equal(settingsAfterPlan(undefined, { model: "model-a", mode: "default" }, catalog), undefined);
  assert.throws(() => settingsAfterPlan(undefined, previous, { ...catalog, models: [] }), { code: "CODEX_MODEL_UNAVAILABLE" });
});
test("model discovery filters hidden entries and extracts only displayable fields", () => {
  assert.deepEqual(parseModels({ data: [{ model: "model-a", displayName: "A", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], secret: "must not be copied" }, { hidden: true }] }), [{ model: "model-a", displayName: "A", defaultEffort: "low", efforts: ["low"] }]);
  assert.throws(() => parseModels({ data: [{}] }));
});
test("observed settings only come from an actual model-bearing response", () => {
  assert.equal(readObservedSettings({ codexVersion: "0.153.2" }), undefined);
  const actual = readObservedSettings({ model: "model-a", modelProvider: "provider", reasoningEffort: "high", config: { apiKey: "never export" } });
  assert.equal(actual?.model, "model-a");
  assert.equal(actual?.effort, "high");
  assert.ok(actual?.observedAt);
  assert.equal(Object.hasOwn(actual!, "config"), false);
});

test("new panel turns explicitly leave native Plan without changing selected models or saved Plan", () => {
  const observed = {model:"model-a",effort:"high",observedAt:new Date().toISOString()};
  assert.deepEqual(resolveTurnMode(undefined,observed,undefined,"default",catalog),{model:"model-a",effort:"high",mode:"default"});
  assert.deepEqual(resolveTurnMode({model:"model-a",effort:"low"},observed,undefined,"plan",catalog),{model:"model-a",effort:"low",mode:"plan"});
  assert.throws(()=>resolveTurnMode(undefined,undefined,undefined,"default",catalog),{code:"CODEX_MODEL_UNRESOLVED"});
  assert.throws(()=>resolveTurnMode(undefined,observed,undefined,"invented",catalog),{code:"CODEX_MODE_UNAVAILABLE"});
});
