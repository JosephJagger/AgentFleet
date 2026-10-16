/**
 * Published connection state of the active voice call (global coordinator or session voice), so the
 * screensaver can show it and react to a new connection. Ownership keeps an idle panel from
 * overwriting the state of another panel's live call.
 */
import { useSyncExternalStore } from "react";

export type VoicePhase = "idle" | "connecting" | "connected" | "recovering" | "error";
export type VoiceStatus = { phase: VoicePhase; muted: boolean; kind: "global" | "session"; connectedSeq: number; /** The call is held while its signaling socket reconnects. */ degraded: boolean };
const IDLE: VoiceStatus = { phase: "idle", muted: false, kind: "global", connectedSeq: 0, degraded: false };

let state = IDLE, owner: unknown;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export const voiceStatus = {
  get: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  /** `connectedSeq` increases only on connecting → connected, never on recovery, so it marks "a call just connected". */
  publish(by: unknown, next: { phase: VoicePhase; muted: boolean; kind: "global" | "session"; degraded?: boolean }) {
    if (next.phase === "idle") { if (owner === by) this.release(by); return; }
    const previous = owner === by ? state.phase : "idle";
    owner = by;
    state = { ...next, degraded: next.degraded === true, connectedSeq: state.connectedSeq + (next.phase === "connected" && previous === "connecting" ? 1 : 0) };
    emit();
  },
  release(by: unknown) {
    if (owner !== by) return;
    owner = undefined; state = { ...IDLE, connectedSeq: state.connectedSeq }; emit();
  },
};
export const useVoiceStatus = () => useSyncExternalStore(voiceStatus.subscribe, voiceStatus.get, () => IDLE);
