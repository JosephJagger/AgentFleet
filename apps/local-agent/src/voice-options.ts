import { AgentError } from "./errors.js";
// Reviewed releases retain the same realtime methods and voice schema.
export const supportsNativeVoice = (version: string | null | undefined) => version === "0.159.2" || version === "0.160.1" || version === "0.162.1" || version === "0.163.0";
export const REALTIME_VOICES = ["alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember", "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse"] as const;
export type RealtimeVoice = typeof REALTIME_VOICES[number];
export function parseRealtimeVoice(value: unknown): RealtimeVoice {
  if (value === undefined) return "sol";
  if (typeof value !== "string" || !REALTIME_VOICES.includes(value as RealtimeVoice)) throw new AgentError("VOICE_INVALID", "Unsupported native voice");
  return value as RealtimeVoice;
}
