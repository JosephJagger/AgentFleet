import { useEffect, useState, useSyncExternalStore } from "react";

/** Broadcast-effect screensaver preferences; stored locally and never affect app behaviour. */
import type { EffectMode } from "./buzhoushan-effect-common";
export type ScreensaverMode = "auto" | EffectMode;
/** Effects in rotation/test order; keys 1..n choose them in the preview. */
export const SCREENSAVER_EFFECTS: EffectMode[] = ["particles", "smoke", "matrix", "attractor", "wavegrid", "starfield", "threebody", "proton", "glyph"];
/** The order the arrows step through; the glyph ripples (which mirror the call voice) come first. */
export const SCREENSAVER_ORDER: EffectMode[] = ["glyph", ...SCREENSAVER_EFFECTS.filter(mode => mode !== "glyph")];
export const SCREENSAVER_MODES: ScreensaverMode[] = ["auto", ...SCREENSAVER_EFFECTS];
export type ScreensaverQuality = "auto" | "high" | "medium" | "low";
export const SCREENSAVER_QUALITIES: ScreensaverQuality[] = ["auto", "high", "medium", "low"];
export type ScreensaverPrefs = { enabled: boolean; seconds: number; mode: ScreensaverMode; quality: ScreensaverQuality; autoVoice: boolean };
const KEY = "agentfleet.buzhoushan.screensaver";
const CHANGED = "agentfleet:buzhoushan-screensaver";
export const SCREENSAVER_DEFAULT: ScreensaverPrefs = { enabled: true, seconds: 30, mode: "auto", quality: "auto", autoVoice: true };
export const SCREENSAVER_MIN_SECONDS = 10;
export const SCREENSAVER_MAX_SECONDS = 600;

const clampSeconds = (value: unknown) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(SCREENSAVER_MAX_SECONDS, Math.max(SCREENSAVER_MIN_SECONDS, n)) : SCREENSAVER_DEFAULT.seconds;
};

function readRaw(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function parseScreensaverPrefs(raw: string): ScreensaverPrefs {
  try {
    const saved = JSON.parse(raw || "{}");
    return {
      enabled: saved?.enabled !== false,
      seconds: saved?.seconds === undefined ? SCREENSAVER_DEFAULT.seconds : clampSeconds(saved.seconds),
      mode: SCREENSAVER_MODES.includes(saved?.mode) ? saved.mode : SCREENSAVER_DEFAULT.mode,
      quality: SCREENSAVER_QUALITIES.includes(saved?.quality) ? saved.quality : SCREENSAVER_DEFAULT.quality,
      autoVoice: saved?.autoVoice !== false,
    };
  } catch { return { ...SCREENSAVER_DEFAULT }; }
}
export function saveScreensaverPrefs(next: ScreensaverPrefs) {
  const value = { enabled: next.enabled, seconds: clampSeconds(next.seconds), mode: SCREENSAVER_MODES.includes(next.mode) ? next.mode : SCREENSAVER_DEFAULT.mode, quality: SCREENSAVER_QUALITIES.includes(next.quality) ? next.quality : SCREENSAVER_DEFAULT.quality, autoVoice: next.autoVoice !== false };
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* Preference still applies to this page load. */ }
  memory = JSON.stringify(value);
  window.dispatchEvent(new Event(CHANGED));
}
let memory: string | undefined;
const snapshot = () => memory ?? readRaw();
const subscribe = (notify: () => void) => {
  window.addEventListener(CHANGED, notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener(CHANGED, notify); window.removeEventListener("storage", notify); };
};
export function useScreensaverPrefs(): ScreensaverPrefs {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseScreensaverPrefs(raw);
}

const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
/**
 * True after `timeoutMs` without mouse/keyboard/touch input. Listeners are passive and
 * never stop or alter the events, so the underlying application keeps working.
 */
export function useIdle(timeoutMs: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!enabled) { setIdle(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => setIdle(true), timeoutMs); };
    const activity = () => { setIdle(false); arm(); };
    arm();
    for (const name of INPUT_EVENTS) window.addEventListener(name, activity, { passive: true, capture: true });
    return () => { clearTimeout(timer); for (const name of INPUT_EVENTS) window.removeEventListener(name, activity, { capture: true }); };
  }, [timeoutMs, enabled]);
  return idle && enabled;
}

/** Toolbar request to raise the screensaver at once, without waiting for the idle timer. */
let requests = 0;
const requestListeners = new Set<() => void>();
export function requestScreensaver() { requests++; requestListeners.forEach(listener => listener()); }
export function useScreensaverRequests(): number {
  return useSyncExternalStore(
    notify => { requestListeners.add(notify); return () => { requestListeners.delete(notify); }; },
    () => requests,
    () => 0,
  );
}
