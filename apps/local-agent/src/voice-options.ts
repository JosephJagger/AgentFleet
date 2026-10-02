import { AgentError } from "./errors.js";
// Verified against the managed Codex 0.159.2 RealtimeVoice schema.
export const REALTIME_VOICES = ["alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse"] as const;
export type RealtimeVoice = typeof REALTIME_VOICES[number];
export function parseRealtimeVoice(value: unknown): RealtimeVoice {
  if (value === undefined) return "sol";
  if (typeof value !== "string" || !REALTIME_VOICES.includes(value as RealtimeVoice)) throw new AgentError("VOICE_INVALID", "Unsupported native voice");
  return value as RealtimeVoice;
}
