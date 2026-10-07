import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";
import { parseCodexCatalog, validateCodexSettings, type CodexSettings, type CodexCatalog } from "./codex-settings.js";

export const settingFields = ["model", "effort", "mode", "serviceTier", "personality", "summary", "multiAgentMode", "disabledPluginIds"] as const;
export type SettingsScope = "workspace" | "machine" | "project" | "session";
export type FieldOverrides = Partial<Record<Exclude<typeof settingFields[number], "disabledPluginIds">, string | null>> & { disabledPluginIds?: string[] | "__native__" };
const scopes: SettingsScope[] = ["workspace", "machine", "project", "session"];
const native = "__native__";
type Preference = { settings: CodexSettings | null; overrides: FieldOverrides; revision: number };

/** Omitted fields inherit; __native__ stops inheritance without sending an override.
 * A null serviceTier explicitly clears the tier in the native runtime. */
export function parseFieldOverrides(value: unknown): FieldOverrides {
  invariant(value && typeof value === "object" && !Array.isArray(value), 400, "INVALID_CODEX_SETTINGS", "Expected field overrides");
  const raw = value as FieldOverrides;
  invariant(Object.keys(raw).every(k => settingFields.includes(k as typeof settingFields[number])), 400, "INVALID_CODEX_SETTINGS", "Unknown runtime setting");
  for (const field of settingFields) {
    const v = raw[field];
    if (v === undefined || v === native) continue;
    if (field === "disabledPluginIds") { invariant(Array.isArray(v) && v.length <= 100 && v.every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("\0")), 400, "INVALID_CODEX_SETTINGS", "Invalid disabled plugins"); continue; }
    invariant(field === "serviceTier" && v === null || typeof v === "string" && v.length > 0 && v.length <= 256 && !v.includes("\0"), 400, "INVALID_CODEX_SETTINGS", "Invalid setting value");
    if (field === "mode") invariant(v === "plan" || v === "default", 400, "INVALID_CODEX_SETTINGS", "Invalid mode");
    if (field === "summary") invariant(["auto", "concise", "detailed", "none"].includes(String(v)), 400, "INVALID_CODEX_SETTINGS", "Invalid summary");
    if (field === "multiAgentMode") invariant(["explicitRequestOnly", "proactive"].includes(String(v)), 400, "INVALID_CODEX_SETTINGS", "Invalid delegation mode");
    if (field === "personality") invariant(["none", "friendly", "pragmatic"].includes(String(v)), 400, "INVALID_CODEX_SETTINGS", "Invalid personality");
  }
  return raw;
}
export class CodexPreferencesService {
  constructor(private readonly db: ControlPlaneDatabase) {}
  private targets(principal: Principal, scope: SettingsScope, id: string) {
    if (scope === "workspace") return { workspace: principal.workspaceId, machine: undefined, project: undefined, session: undefined, catalog: null as CodexCatalog | null, runtime: null as string | null };
    const sql = scope === "machine"
      ? "SELECT machine_id, NULL AS project_id,NULL AS runtime_settings_json,codex_catalog_json FROM machines WHERE machine_id=? AND workspace_id=? AND identity_state='active'"
      : scope === "project"
      ? "SELECT p.machine_id,p.project_id,NULL AS runtime_settings_json,m.codex_catalog_json FROM projects p JOIN machines m USING(machine_id) WHERE p.project_id=? AND p.workspace_id=? AND p.provider='codex' AND m.identity_state='active'"
      : "SELECT s.machine_id,s.project_id,s.runtime_settings_json,m.codex_catalog_json FROM logical_sessions s JOIN machines m USING(machine_id) JOIN projects p ON p.project_id=s.project_id WHERE s.logical_session_id=? AND s.workspace_id=? AND p.provider='codex' AND m.identity_state='active'";
    const row = this.db.get<{ machine_id: string; project_id: string | null; codex_catalog_json: string | null; runtime_settings_json: string | null }>(sql, id, principal.workspaceId);
    invariant(row, 404, "SETTINGS_TARGET_NOT_FOUND", "Active configuration target was not found");
    return { workspace: principal.workspaceId, machine: row.machine_id, project: row.project_id ?? undefined, session: scope === "session" ? id : undefined,
      catalog: row.codex_catalog_json ? parseCodexCatalog(JSON.parse(row.codex_catalog_json)) : null, runtime: row.runtime_settings_json };
  }
  readTarget(principal: Principal, scope: SettingsScope, id = principal.workspaceId) {
    const targets = this.targets(principal, scope, id);
    const preferences = Object.fromEntries(scopes.map(s => {
      const row = targets[s] ? this.db.get<{ settings_json: string | null; field_overrides_json: string | null; revision: number }>(
        "SELECT settings_json,field_overrides_json,revision FROM codex_preferences WHERE workspace_id=? AND scope=? AND target_id=?", principal.workspaceId, s, targets[s]!) : undefined;
      const settings = row?.settings_json ? JSON.parse(row.settings_json) as CodexSettings : null;
      // Legacy whole-group overrides pin missing fields to native, preserving behavior.
      const overrides = row?.field_overrides_json ? JSON.parse(row.field_overrides_json) as FieldOverrides : settings
        ? Object.fromEntries(settingFields.filter(f => !["summary", "multiAgentMode", "disabledPluginIds"].includes(f) || settings[f] !== undefined).map(f => [f, settings[f] === undefined ? native : settings[f]])) as FieldOverrides : {};
      // Missing/legacy-native mode inherits independently of the model.
      if (overrides.mode === native) delete overrides.mode;
      return [s, { settings, overrides, revision: row?.revision ?? 0 }];
    })) as Record<SettingsScope, Preference>;
    const sources = Object.fromEntries(settingFields.map(f => [f, "codex"])) as Record<typeof settingFields[number], SettingsScope | "codex">;
    const effective: FieldOverrides = { mode: "default" };
    sources.mode = "workspace";
    let source: SettingsScope | "codex" = "codex";
    for (const s of scopes) for (const f of settingFields) if (preferences[s].overrides[f] !== undefined) {
      Object.assign(effective, { [f]: preferences[s].overrides[f] }); sources[f] = s; source = s;
    }
    const values = Object.fromEntries(Object.entries(effective).filter(([, v]) => v !== native));
    let resolutionIssue: string | undefined;
    // Native protocol requires a model with runtime overrides. Resolve from the
    // most recent host observation only; never choose an arbitrary catalog model.
    if (!values.model && Object.keys(values).length) {
      const runtime = targets.runtime ? JSON.parse(targets.runtime) : null;
      const current = runtime?.accepted && (!runtime.observed || Date.parse(runtime.accepted.acceptedAt) > Date.parse(runtime.observed.observedAt)) ? runtime.accepted : runtime?.observed;
      if (current?.model) values.model = current.model;
      else if (Object.keys(values).some(field => field !== "mode")) resolutionIssue = "原生模型尚未上报；请选择模型或等待主机同步后再发送。";
    }
    const desired = values.model ? values as unknown as CodexSettings : null;
    let compatibilityIssue = resolutionIssue;
    if (desired && scope !== "workspace") {
      try { validateCodexSettings(desired, targets.catalog); } catch (error) { compatibilityIssue = (error as Error).message; }
    }
    const catalogs = scope === "workspace" ? this.db.all<{ machine_id: string; codex_catalog_json: string | null }>(
      "SELECT machine_id,codex_catalog_json FROM machines WHERE workspace_id=? AND identity_state='active'", principal.workspaceId)
      .map(m => ({ machineId: m.machine_id, catalog: m.codex_catalog_json ? parseCodexCatalog(JSON.parse(m.codex_catalog_json)) : null })) : undefined;
    return { catalog: targets.catalog, catalogs, preferences, source, sources, effective, desired, resolutionIssue, compatibilityIssue };
  }
  writeTarget(principal: Principal, scope: SettingsScope, id: string, input: Record<string, unknown>) {
    const targets = this.targets(principal, scope, id);
    invariant(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 400, "INVALID_SETTINGS_REVISION", "Settings revision is required");
    invariant(input.overrides !== undefined || input.settings !== undefined, 400, "INVALID_CODEX_SETTINGS", "Specify overrides or settings");
    invariant(!(input.overrides !== undefined && input.settings !== undefined),400,"INVALID_CODEX_SETTINGS","Use one settings format");
    // Old clients retain whole-group semantics; new clients explicitly edit fields.
    const settings = input.overrides !== undefined || input.settings === null ? null : validateCodexSettings(input.settings, targets.catalog);
    const overrides = input.overrides === undefined ? null : parseFieldOverrides(input.overrides);
    return this.db.transaction(() => {
      const current = this.readTarget(principal, scope, id).preferences[scope];
      invariant(current.revision === input.revision, 409, "SETTINGS_REVISION_CONFLICT", "Settings changed in another browser; reload before saving");
      this.db.run(`INSERT INTO codex_preferences(workspace_id,scope,target_id,settings_json,field_overrides_json,revision,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,scope,target_id) DO UPDATE SET settings_json=excluded.settings_json,field_overrides_json=excluded.field_overrides_json,revision=excluded.revision,updated_at=excluded.updated_at`,
        principal.workspaceId, scope, targets[scope]!, settings ? JSON.stringify(settings) : null, overrides ? JSON.stringify(overrides) : null, current.revision + 1, nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, action: "codex.preferences.save", metadata: { scope, targetId: targets[scope], revision: current.revision + 1 } });
      return this.readTarget(principal, scope, id);
    });
  }
  readMachine(principal: Principal, id: string) { return this.readTarget(principal, "machine", id); }
  writeMachine(principal: Principal, id: string, input: Record<string, unknown>) {
    invariant(input.scope === undefined || input.scope === "machine", 400, "INVALID_SETTINGS_SCOPE", "Host endpoint only accepts host defaults");
    return this.writeTarget(principal, "machine", id, input);
  }
  read(principal: Principal, id: string) { return this.readTarget(principal, "session", id); }
  write(principal: Principal, id: string, input: Record<string, unknown>) {
    const scope = input.scope;
    invariant(scope === "machine" || scope === "project" || scope === "session", 400, "INVALID_SETTINGS_SCOPE", "Choose host, project or session scope");
    this.writeTarget(principal, scope, this.targets(principal, "session", id)[scope]!, input);
    return this.read(principal, id);
  }
}
