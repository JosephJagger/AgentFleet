export interface CodexSettings { model: string; effort?: string; mode?: "default" | "plan"; serviceTier?: string | null; disabledPluginIds?: string[]; summary?: "auto" | "concise" | "detailed" | "none"; multiAgentMode?: "explicitRequestOnly" | "proactive"; personality?: "none" | "friendly" | "pragmatic" }
export interface CodexCatalog {
  imageInput?: boolean;
  fileInput?: boolean;
  plugins?: Array<{ pluginId: string; pluginName: string }>;
  pluginSkills?: Array<{ pluginId: string; pluginName: string; name: string; description: string; path: string }>;
  models: Array<{ model: string; displayName: string; efforts: string[]; defaultEffort: string; serviceTiers?: { id: string; name: string }[]; supportsPersonality?: boolean }>;
  modes: string[];
  fetchedAt: string;
  error?: string;
  modeNotice?: string;
}
export type SettingsScope = "workspace" | "machine" | "project" | "session";
export type FieldOverrides = Partial<Record<Exclude<keyof CodexSettings, "disabledPluginIds">, string | null>> & { disabledPluginIds?: string[] | "__native__" };
export interface CodexPreferences {
  catalogs?: { machineId: string; catalog: CodexCatalog | null }[];
  sources?: Partial<Record<keyof CodexSettings, SettingsScope | "codex">>;
  effective?: FieldOverrides;
  compatibilityIssue?: string;
  resolutionIssue?: string;
  catalog: CodexCatalog | null;
  preferences: Record<"machine" | "project" | "session", { settings: CodexSettings | null; overrides?: FieldOverrides; revision: number }> & Partial<Record<"workspace", { settings: CodexSettings | null; overrides?: FieldOverrides; revision: number }>>;
  source: "workspace" | "machine" | "project" | "session" | "codex";
  desired: CodexSettings | null;
}
export interface RuntimeSettings {
  active?: { source?: "native_voice"; nativeTurnId: string; changedAt: string; model?: string; effort?: string; serviceTier?: string | null; summary?: string };
  permissions?: { profile: "project" | "network" | "full"; source: string; acceptedAt: string; nativeTurnId: string };
  archived?: boolean;
  observed?: { model: string; provider?: string; effort?: string; observedAt: string };
  accepted?: CodexSettings & { acceptedAt: string; nativeTurnId: string };
}
