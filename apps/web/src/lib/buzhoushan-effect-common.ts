export type EffectMode = "rings" | "sonogram" | "glyph" | "particles" | "smoke" | "matrix" | "attractor" | "wavegrid" | "starfield" | "threebody" | "proton";
export type Pointer = { x: number; y: number; active: boolean };
export type VoiceRole = "mic" | "ai";
/** One voice onset, placed by pitch (x) and speaker (y band); strength is 0..1. */
export type Impulse = { role: VoiceRole; x: number; y: number; strength: number };
export const VOICE_BANDS = 48;
/** `bands` are smoothed log-spaced spectrum levels (0..1, low pitch first); `waves` are -1..1 waveform samples. Do not retain them across frames. */
export type VoiceParams = { mic: number; ai: number; impulses: Impulse[]; connected: boolean; bands?: { mic: Float32Array; ai: Float32Array }; waves?: { mic: Float32Array; ai: Float32Array } };
export type EffectParams = { busy: boolean; pointer?: Pointer; voice?: VoiceParams };
/** Latin letters, digits and code symbols only (no kana), shared by the glyph-based effects. */
export const GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0101<>{}[]()/\\|=+-*#$%&@:;.";
export interface Effect {
  /** `dpr` is the (already capped) device pixel ratio the backing store should use. */
  resize(width: number, height: number, dpr?: number): void;
  frame(dt: number, time: number, params: EffectParams): void;
  dispose(): void;
}
export const TAU = Math.PI * 2;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
/** Idle palette runs cyan → violet → magenta; a running task shifts it to green/teal. */
export function hueFor(unit: number, busy: boolean): number {
  return busy ? 95 + unit * 85 : 190 + unit * 120;
}
/**
 * Size the backing store in device pixels and draw in CSS pixels (via a scale transform), so
 * lines and text stay sharp on displays with Windows scaling (125%/150%) or 4K.
 */
export function setupCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number, dpr = 1): { w: number; h: number } {
  const w = Math.max(2, Math.floor(width)), h = Math.max(2, Math.floor(height)), d = Math.max(1, dpr);
  canvas.width = Math.ceil(w * d); canvas.height = Math.ceil(h * d);
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  return { w, h };
}

export type QualityTier = "low" | "medium" | "high";
export const QUALITY_TIERS: QualityTier[] = ["low", "medium", "high"];
export interface Quality {
  tier: QualityTier; maxDpr: number;
  /** Particle buffer resolution relative to CSS pixels (times min(dpr, 1.5)). */
  particleScale: number; particles: number; smokeWidth: number; attractor: number; stars: number;
}
const TIERS: Record<QualityTier, Quality> = {
  low: { tier: "low", maxDpr: 1, particleScale: 0.55, particles: 22000, smokeWidth: 128, attractor: 3500, stars: 1500 },
  medium: { tier: "medium", maxDpr: 1.25, particleScale: 0.7, particles: 32000, smokeWidth: 160, attractor: 5500, stars: 2200 },
  high: { tier: "high", maxDpr: 2, particleScale: 0.85, particles: 45000, smokeWidth: 192, attractor: 8000, stars: 3200 },
};
export const qualityFor = (tier: QualityTier): Quality => TIERS[tier];

/** GPU description via WebGL; software renderers mean hardware acceleration is off. */
let gpu: { renderer: string; software: boolean } | undefined;
export function describeGpu(): { renderer: string; software: boolean } {
  if (gpu) return gpu;
  try {
    const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return (gpu = { renderer: "", software: true });
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return (gpu = { renderer, software: /swiftshader|basic render|llvmpipe|software|softpipe/i.test(renderer) });
  } catch { return (gpu = { renderer: "", software: true }); }
}
