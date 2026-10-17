import type { MachineSummary } from "./api-schema.js";

/**
 * Codex runtimes are distributed and promoted by the panel operator. Other members only need to know which Codex
 * version a host runs, so rollout phases, the promotion target and its validation evidence are removed server-side
 * (not merely hidden by the UI) for everyone except the platform administrator.
 */
const ROLLOUT_KEYS = ["runtimeUpdateState", "runtimeUpdateTarget", "runtimeUpdateError"] as const;

export function redactMachineCodexStatus<T extends Pick<MachineSummary, "codexProfile">>(machine: T): T {
  const profile = machine.codexProfile;
  if (!profile || !ROLLOUT_KEYS.some(key => key in profile)) return machine;
  const visible = { ...profile };
  for (const key of ROLLOUT_KEYS) delete visible[key];
  return { ...machine, codexProfile: visible };
}

/** The browser treats "unknown" as "no verified target", which is exactly what a non-administrator should see. */
export function redactCompatibilityProfile(profile: unknown): Record<string, unknown> {
  return { ...(profile && typeof profile === "object" ? profile : {}), profileVersion: "", validationStatus: "unknown", managedCodexVersion: "", schemaHash: "", lastValidatedAt: "", upgradePolicy: "unknown" };
}

export function redactDashboardCodexStatus(dashboard: Record<string, unknown>): Record<string, unknown> {
  const machines = Array.isArray(dashboard.machines) ? (dashboard.machines as Array<Pick<MachineSummary, "codexProfile">>).map(redactMachineCodexStatus) : dashboard.machines;
  return { ...dashboard, machines, compatibilityProfile: redactCompatibilityProfile(dashboard.compatibilityProfile) };
}
