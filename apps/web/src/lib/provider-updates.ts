import type { ProviderId } from "./provider-catalog";
import type { ProviderRuntimeState } from "./provider-runtime-policy";
import type { Machine } from "./types";

/** What the panel may offer for one agent. Nothing here installs anything; every kind needs an explicit click or is information only. */
export type UpdateOffer =
  | { kind: "codex-confirm"; latest: string }
  | { kind: "claude-update"; latest: string }
  | { kind: "notify"; latest: string };

const triple = (value?: string | null) => { const match = value?.match(/\d+\.\d+\.\d+/); return match ? match[0].split(".").map(Number) as [number, number, number] : undefined; };
export function isNewerVersion(latest?: string | null, installed?: string | null): boolean {
  const a = triple(latest), b = triple(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/**
 * @param installed the version this host actually runs for the agent (managed build for managed Claude).
 */
export function providerUpdateOffer(id: ProviderId, machine: Machine, policy: ProviderRuntimeState | undefined, installed: string | null | undefined): UpdateOffer | undefined {
  if (machine.reachability !== "live") return undefined;
  if (id === "codex") {
    const profile = machine.codexProfile ?? {};
    const target = typeof profile.runtimeUpdateTarget === "string" ? profile.runtimeUpdateTarget : "";
    if (profile.source === "managed" && profile.runtimeUpdateState === "awaiting_confirmation" && isNewerVersion(target, machine.codexVersion)) return { kind: "codex-confirm", latest: target };
    return undefined;
  }
  const latest = id === "claude" ? policy?.latest?.claude?.version ?? policy?.stableVersion : policy?.latest?.[id]?.version;
  if (!latest || !isNewerVersion(latest, installed)) return undefined;
  // Kimi moved from a Python to a Node.js distribution with a new major version; that is a migration, not an update.
  if (id === "kimi" && triple(latest)![0] !== triple(installed)![0]) return undefined;
  if (id === "claude") {
    if (policy?.mode === "auto") return undefined;
    return policy?.mode && policy.mode !== "host" && policy.current ? { kind: "claude-update", latest } : { kind: "notify", latest };
  }
  return { kind: "notify", latest };
}
