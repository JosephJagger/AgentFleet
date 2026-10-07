import { AgentError } from "./errors.js";
import { isRecord, nowIso } from "./util.js";

export interface CodexSettings {
  model: string;
  effort?: string;
  mode?: "default" | "plan";
  serviceTier?: string | null;
  disabledPluginIds?: string[]; summary?: "auto" | "concise" | "detailed" | "none"; multiAgentMode?: "explicitRequestOnly" | "proactive"; personality?: "none" | "friendly" | "pragmatic";
}
export interface CodexModel {
  inputModalities?: string[];
  model: string;
  displayName: string;
  efforts: string[];
  defaultEffort: string;
  serviceTiers?: { id: string; name: string }[];
  supportsPersonality?: boolean;
}
export interface CodexCatalog {
  imageInput?: boolean;
  fileInput?: boolean;
  plugins?: Array<{ pluginId: string; pluginName: string }>;
  pluginSkills?: Array<{ pluginId: string; pluginName: string; name: string; description: string; path: string }>;
  models: CodexModel[];
  modes: string[];
  fetchedAt: string;
  error?: string;
  modeNotice?: string;
}
export interface CodexObservedSettings {
  model: string;
  provider?: string;
  effort?: string;
  observedAt: string;
}

export function readObservedSettings(raw: Record<string, unknown>): CodexObservedSettings | undefined {
  if (typeof raw.model !== "string" || !raw.model || raw.model.length > 256) return undefined;
  return { model: raw.model, observedAt: nowIso(),
    ...(typeof raw.modelProvider === "string" ? { provider: raw.modelProvider.slice(0, 256) } : {}),
    ...(typeof raw.reasoningEffort === "string" ? { effort: raw.reasoningEffort.slice(0, 32) } : {}),
  };
}

export function parseModels(value: unknown): CodexModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new AgentError("CODEX_CATALOG_INVALID", "Codex model catalog is invalid");
  return value.data.filter(isRecord).filter((item) => item.hidden !== true).map((item) => {
    if (typeof item.model !== "string" || !item.model || item.model.length > 256 || !Array.isArray(item.supportedReasoningEfforts)) {
      throw new AgentError("CODEX_CATALOG_INVALID", "Codex model entry is invalid");
    }
    return { model: item.model, displayName: typeof item.displayName === "string" ? item.displayName.slice(0, 256) : item.model,
      ...(Array.isArray(item.inputModalities) ? { inputModalities: item.inputModalities.filter((v): v is string => v === "text" || v === "image") } : {}),
      efforts: item.supportedReasoningEfforts.filter(isRecord).map((entry) => entry.reasoningEffort).filter((effort): effort is string => typeof effort === "string" && effort.length <= 32),
      defaultEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : "",
      ...(Array.isArray(item.serviceTiers) ? { serviceTiers: item.serviceTiers.filter(isRecord).filter((tier) => typeof tier.id === "string" && tier.id.length <= 64).slice(0, 16).map((tier) => ({ id: tier.id as string, name: typeof tier.name === "string" ? tier.name.slice(0, 128) : tier.id as string })) } : {}),
      ...(typeof item.supportsPersonality === "boolean" ? { supportsPersonality: item.supportsPersonality } : {}),
    };
  });
}

export function validateSettings(value: unknown, catalog: CodexCatalog | undefined): CodexSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !["model", "effort", "mode", "serviceTier", "personality", "summary", "multiAgentMode", "disabledPluginIds"].includes(key)) || typeof value.model !== "string") {
    throw new AgentError("CODEX_SETTINGS_INVALID", "Only documented runtime settings are accepted");
  }
  if (value.summary !== undefined && !["auto", "concise", "detailed", "none"].includes(String(value.summary)) || value.multiAgentMode !== undefined && !["explicitRequestOnly", "proactive"].includes(String(value.multiAgentMode))) throw new AgentError("CODEX_SETTINGS_INVALID", "Invalid summary or delegation mode");
  if (value.disabledPluginIds !== undefined && (!Array.isArray(value.disabledPluginIds) || value.disabledPluginIds.length > 100 || value.disabledPluginIds.some(id => typeof id !== "string" || !id || id.length > 256 || id.includes("\0")))) throw new AgentError("CODEX_SETTINGS_INVALID", "Invalid disabled plugins");
  const model = catalog?.models.find((item) => item.model === value.model);
  if (!model || catalog?.error) throw new AgentError("CODEX_MODEL_UNAVAILABLE", "Refresh the host model catalog before selecting a model");
  if (value.effort !== undefined && (typeof value.effort !== "string" || !model.efforts.includes(value.effort))) {
    throw new AgentError("CODEX_EFFORT_UNAVAILABLE", "The selected model does not support this reasoning effort");
  }
  if (value.mode !== undefined && ((value.mode !== "default" && value.mode !== "plan") || !catalog?.modes.includes(value.mode))) {
    throw new AgentError("CODEX_MODE_UNAVAILABLE", "This Codex runtime does not support the selected mode");
  }
  if (value.serviceTier !== undefined && value.serviceTier !== null && !model.serviceTiers?.some((tier) => tier.id === value.serviceTier)) throw new AgentError("CODEX_SETTINGS_INVALID", "Host model does not advertise this service tier");
  if (value.personality !== undefined && (!model.supportsPersonality || !["none", "friendly", "pragmatic"].includes(String(value.personality)))) throw new AgentError("CODEX_SETTINGS_INVALID", "Host model does not support this personality");
  return { ...(value.disabledPluginIds === undefined ? {} : { disabledPluginIds: [...value.disabledPluginIds as string[]] }), ...(value.summary === undefined ? {} : { summary: value.summary as NonNullable<CodexSettings["summary"]> }), ...(value.multiAgentMode === undefined ? {} : { multiAgentMode: value.multiAgentMode as NonNullable<CodexSettings["multiAgentMode"]> }), model: model.model, ...(value.effort === undefined ? {} : { effort: value.effort as string }), ...(value.mode === undefined ? {} : { mode: value.mode as "default" | "plan" }),
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier as string | null }), ...(value.personality === undefined ? {} : { personality: value.personality as NonNullable<CodexSettings["personality"]> }) };
}

export function settingsAfterPlan(settings: CodexSettings | undefined, previous: CodexSettings | undefined, catalog: CodexCatalog | undefined): CodexSettings | undefined {
  if (settings?.mode || previous?.mode !== "plan") return settings;
  const base = settings ?? { model: previous.model, ...(previous.effort ? { effort: previous.effort } : {}) };
  return validateSettings({ ...base, mode: "default" }, catalog);
}

/** Resolve a new panel turn after native thread creation/resume; never guess a model. */
export function resolveTurnMode(settings: CodexSettings | undefined, observed: CodexObservedSettings | undefined, previous: CodexSettings | undefined, mode: unknown, catalog: CodexCatalog | undefined): CodexSettings | undefined {
  // Previously queued commands retain their original semantics.
  if (mode === undefined) return settingsAfterPlan(settings, previous, catalog);
  if (mode !== "default" && mode !== "plan") throw new AgentError("CODEX_MODE_UNAVAILABLE", "Invalid resolved collaboration mode");
  const base = settings ?? (observed ? { model: observed.model, ...(observed.effort ? { effort: observed.effort } : {}) } : previous);
  if (!base) throw new AgentError("CODEX_MODEL_UNRESOLVED", "原生模型尚未上报；请选择模型或等待主机同步后再发送。");
  return validateSettings({ ...base, mode }, catalog);
}

export function turnSettingsParams(settings: CodexSettings | undefined): Record<string, unknown> {
  if (!settings) return {};
  return { ...(settings.disabledPluginIds === undefined ? {} : { disabledPluginIds: settings.disabledPluginIds }), ...(settings.summary ? { summary: settings.summary } : {}), ...(settings.multiAgentMode ? { multiAgentMode: settings.multiAgentMode } : {}), model: settings.model, ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }), ...(settings.personality ? { personality: settings.personality } : {}),
    ...(settings.mode ? { collaborationMode: { mode: settings.mode, settings: {
      model: settings.model, reasoning_effort: settings.effort ?? null, developer_instructions: null,
    } } } : {}),
  };
}
