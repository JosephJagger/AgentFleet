export type EffectMode = "particles" | "smoke" | "matrix" | "attractor" | "wavegrid" | "starfield" | "threebody" | "proton";
export type Pointer = { x: number; y: number; active: boolean };
export type EffectParams = { busy: boolean; pointer?: Pointer };
export interface Effect {
  resize(width: number, height: number): void;
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
export function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number) {
  canvas.width = Math.max(2, Math.floor(w)); canvas.height = Math.max(2, Math.floor(h));
}
