import { useEffect, useState, useSyncExternalStore } from "react";

/** Broadcast-effect screensaver preferences; stored locally and never affect app behaviour. */
export type ScreensaverPrefs = { enabled: boolean; seconds: number };
const KEY = "agentfleet.buzhoushan.screensaver";
const CHANGED = "agentfleet:buzhoushan-screensaver";
export const SCREENSAVER_DEFAULT: ScreensaverPrefs = { enabled: true, seconds: 30 };
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
    return { enabled: saved?.enabled !== false, seconds: saved?.seconds === undefined ? SCREENSAVER_DEFAULT.seconds : clampSeconds(saved.seconds) };
  } catch { return { ...SCREENSAVER_DEFAULT }; }
}
export function saveScreensaverPrefs(next: ScreensaverPrefs) {
  const value = { enabled: next.enabled, seconds: clampSeconds(next.seconds) };
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
