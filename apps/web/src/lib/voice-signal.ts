/**
 * Read-only audio analysis for the screensaver. It taps the call's microphone stream and the
 * AI's remote stream with AnalyserNodes (never connected to any output), so calls, mute and
 * playback are untouched. Only volume/pitch numbers are computed, in memory: nothing is
 * recorded, stored or sent anywhere.
 */
import { clamp, type Impulse, type VoiceParams, type VoiceRole } from "./buzhoushan-effect-common";

/** RMS level (0..1) and pitch-like spectral centroid (0 = low voice, 1 = high), from analyser data. */
export function analyseSpectrum(time: Uint8Array, freq: Uint8Array, sampleRate: number): { level: number; centroid: number } {
  let sum = 0;
  for (let i = 0; i < time.length; i++) { const d = (time[i] - 128) / 128; sum += d * d; }
  const level = Math.sqrt(sum / Math.max(1, time.length));
  const binHz = sampleRate / (freq.length * 2);
  let weighted = 0, mass = 0;
  for (let i = 1; i < freq.length; i++) {
    const f = i * binHz;
    if (f < 80 || f > 4000) continue;
    weighted += f * freq[i]; mass += freq[i];
  }
  const hz = mass > 200 ? weighted / mass : 600;
  return { level, centroid: clamp((Math.log(hz) - Math.log(100)) / (Math.log(3500) - Math.log(100)), 0, 1) };
}

/**
 * Emits a strength (0..1) when the level jumps above its slow average, with a cooldown. The threshold is low so
 * ordinary speech through a noise-suppressed microphone counts; the first sample only primes the average.
 */
export class OnsetDetector {
  private avg = 0; private last = -Infinity; private primed = false;
  constructor(private cooldownMs = 140, private floor = 0.012) {}
  update(level: number, nowMs: number): number {
    if (!this.primed) { this.primed = true; this.avg = level; return 0; }
    const threshold = this.avg * 1.35 + 0.006;
    let strength = 0;
    if (level > this.floor && level > threshold && nowMs - this.last >= this.cooldownMs) {
      strength = clamp(0.45 + (level - this.avg) * 5, 0.45, 1);
      this.last = nowMs;
    }
    // Rise quickly so sustained loudness stops counting as new onsets; fall a bit slower.
    this.avg += (level - this.avg) * (level > this.avg ? 0.12 : 0.06);
    return strength;
  }
}

const hash = (n: number) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
/** Speakers get their own band: the AI in the upper half, the broadcaster in the lower half; x follows pitch. */
export function placeImpulse(role: VoiceRole, centroid: number, strength: number, nowMs: number): Impulse {
  const jitter = hash(nowMs * 0.001 + (role === "ai" ? 7 : 3));
  return { role, x: 0.06 + 0.88 * centroid, y: role === "ai" ? 0.2 + 0.28 * jitter : 0.54 + 0.28 * jitter, strength };
}

type Tap = { owner: unknown; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; time: Uint8Array; freq: Uint8Array; onset: OnsetDetector; level: number };
const EMPTY: VoiceParams = { mic: 0, ai: 0, impulses: [], connected: false };

class VoiceSignal {
  private ctx?: AudioContext;
  private taps: Partial<Record<VoiceRole, Tap>> = {};
  private lastNow = -1; private lastFrame: VoiceParams = EMPTY;
  get connected() { return Boolean(this.taps.mic || this.taps.ai); }
  /** `owner` identifies the call panel, so one panel closing can never cut another panel's live call. */
  attach(role: VoiceRole, stream: MediaStream, owner: unknown = "default") {
    this.detach(role);
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor || !stream.getAudioTracks().length) return;
      this.ctx ??= new Ctor();
      void this.ctx.resume?.();
      const source = this.ctx.createMediaStreamSource(stream), analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser); // analysis only: the analyser is not connected to the destination
      this.taps[role] = { owner, source, analyser, time: new Uint8Array(analyser.fftSize), freq: new Uint8Array(analyser.frequencyBinCount), onset: new OnsetDetector(), level: 0 };
    } catch { /* The effect is optional; a failure must never affect the call. */ }
  }
  detach(role: VoiceRole) {
    const tap = this.taps[role];
    if (!tap) return;
    try { tap.source.disconnect(); tap.analyser.disconnect(); } catch { /* already disconnected */ }
    delete this.taps[role];
  }
  /** Detach only the taps this owner attached; close the audio context when nothing is left. */
  release(owner: unknown) {
    for (const role of ["mic", "ai"] as const) if (this.taps[role]?.owner === owner) this.detach(role);
    if (!this.connected) this.detachAll();
  }
  detachAll() {
    this.detach("mic"); this.detach("ai");
    const ctx = this.ctx; this.ctx = undefined; this.lastFrame = EMPTY;
    void ctx?.close().catch(() => undefined);
  }
  /** Sample both streams once per animation frame. Repeated calls with the same timestamp return the same frame. */
  /** `sensitivity` scales how loud the voice reads (0.5–3, 1 = normal), for both onsets and continuous level. */
  poll(nowMs: number, sensitivity = 1): VoiceParams {
    if (!this.connected || !this.ctx) return EMPTY;
    if (nowMs === this.lastNow) return this.lastFrame;
    this.lastNow = nowMs;
    const rate = this.ctx.sampleRate, read: Partial<Record<VoiceRole, { level: number; centroid: number }>> = {};
    for (const role of ["mic", "ai"] as const) {
      const tap = this.taps[role];
      if (!tap) continue;
      tap.analyser.getByteTimeDomainData(tap.time as Uint8Array<ArrayBuffer>); tap.analyser.getByteFrequencyData(tap.freq as Uint8Array<ArrayBuffer>);
      read[role] = analyseSpectrum(tap.time, tap.freq, rate);
    }
    // Speaker echo: while the AI is audible the microphone mostly hears the AI, so damp its response.
    const aiLevel = read.ai?.level ?? 0, echo = aiLevel > 0.05 ? 0.3 : 1;
    const impulses: Impulse[] = [];
    for (const role of ["mic", "ai"] as const) {
      const tap = this.taps[role], r = read[role];
      if (!tap || !r) continue;
      const level = (role === "mic" ? r.level * echo : r.level) * sensitivity;
      tap.level += (level - tap.level) * 0.35;
      const strength = tap.onset.update(level, nowMs);
      if (strength > 0) impulses.push(placeImpulse(role, r.centroid, strength, nowMs));
    }
    return (this.lastFrame = { mic: clamp((this.taps.mic?.level ?? 0) * 5, 0, 1), ai: clamp((this.taps.ai?.level ?? 0) * 5, 0, 1), impulses, connected: true });
  }
}
export const voiceSignal = new VoiceSignal();

/** Synthetic alternating voice used by the preview when no call is connected, so the effect can be seen. */
export function createDemoVoice() {
  let next = 0, flip = false, level = 0;
  return (nowMs: number): VoiceParams => {
    const impulses: Impulse[] = [];
    if (nowMs >= next) {
      flip = !flip; next = nowMs + 650 + hash(nowMs) * 700;
      impulses.push(placeImpulse(flip ? "mic" : "ai", hash(nowMs * 0.37), 0.5 + hash(nowMs * 0.11) * 0.5, nowMs));
      level = 0.8;
    }
    level *= 0.94;
    return { mic: flip ? level : 0, ai: flip ? 0 : level, impulses, connected: false };
  };
}
