/**
 * Broadcast screensaver effects built from plain math and physics, drawn on 2D canvases:
 *  - ParticleField: tens of thousands of particles in a divergence-free (curl) flow field,
 *    orbiting gravity wells and a pointer that repels up close and attracts from afar.
 *  - Fluid: Jos Stam's stable-fluids solver (semi-Lagrangian advection, pressure projection,
 *    vorticity confinement) advecting RGB dye.
 *  - MatrixRain: classic falling glyph columns.
 * Each is a small class that can run headless, so the numerics are unit-testable.
 */
import { TAU, clamp, hslToRgb, hueFor, qualityFor, setupCanvas, type Effect, type Quality, type EffectMode, type EffectParams, type Pointer } from "./buzhoushan-effect-common";
import { attractorEffect, protonEffect, starfieldEffect, threeBodyEffect, waveGridEffect } from "./buzhoushan-effects-science";
export { hslToRgb, hueFor, qualityFor };
export type { Effect, EffectMode, EffectParams, Pointer };

/* ------------------------------------------------------------------ particles */

// Stream function terms: psi = sum a*sin(TAU*(fx*u + fy*v) + w*t + phase), u,v in [0,1].
const WAVES = [
  { a: 0.55, fx: 1, fy: 2, w: 0.31, p: 0.3 },
  { a: 0.45, fx: -2, fy: 1, w: -0.23, p: 1.7 },
  { a: 0.3, fx: 3, fy: -1, w: 0.41, p: 3.1 },
  { a: 0.25, fx: 2, fy: 3, w: -0.37, p: 4.4 },
];

/** Velocity (in unit-square per second) of the curl flow: (dpsi/dv, -dpsi/du), divergence-free. */
export function curlFlow(u: number, v: number, t: number, out: [number, number] = [0, 0]): [number, number] {
  let fx = 0, fy = 0;
  for (const k of WAVES) {
    const c = k.a * Math.cos(TAU * (k.fx * u + k.fy * v) + k.w * t + k.p) * TAU;
    fx += c * k.fy;
    fy -= c * k.fx;
  }
  out[0] = fx; out[1] = fy;
  return out;
}

export class ParticleField {
  readonly n: number;
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array; life: Float32Array; tint: Uint8Array;
  w: number; h: number;
  private palette = new Uint8Array(256 * 3);
  private paletteBusy: boolean | undefined;
  // The curl flow is smooth, so it is evaluated on a coarse grid once per step and bilinearly sampled.
  private static readonly GW = 192; private static readonly GH = 108;
  private flowGrid = new Float32Array(193 * 109 * 2);
  constructor(n: number, w: number, h: number, private rand: () => number = Math.random) {
    this.n = n; this.w = w; this.h = h;
    this.x = new Float32Array(n); this.y = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.life = new Float32Array(n); this.tint = new Uint8Array(n);
    for (let i = 0; i < n; i++) { this.respawn(i); this.life[i] = this.rand() * 8; this.tint[i] = Math.floor(this.rand() * 256); }
  }
  resize(w: number, h: number) {
    const sx = w / this.w, sy = h / this.h;
    for (let i = 0; i < this.n; i++) { this.x[i] *= sx; this.y[i] *= sy; }
    this.w = w; this.h = h;
  }
  private respawn(i: number) {
    this.x[i] = this.rand() * this.w; this.y[i] = this.rand() * this.h;
    this.vx[i] = 0; this.vy[i] = 0; this.life[i] = 4 + this.rand() * 8;
  }
  step(dt: number, t: number, busy: boolean, pointer?: Pointer) {
    const { n, w, h, x, y, vx, vy, life } = this;
    const flowScale = h * (busy ? 0.1 : 0.065);
    const soft = (0.035 * h) ** 2;
    const gravity = 5.5e6 * (h / 810) ** 2 * (h / 810);
    // Three gravity wells on slow Lissajous orbits.
    const wells = [0, 1, 2].map(k => ({
      x: w * (0.5 + 0.34 * Math.sin(0.21 * t + k * 2.1)),
      y: h * (0.5 + 0.3 * Math.cos(0.27 * t + k * 1.3 + 0.5)),
      m: k === 0 ? 1 : 0.7,
    }));
    const px = pointer?.active ? pointer.x * w : NaN, py = pointer?.active ? pointer.y * h : NaN;
    const reach = 0.16 * h;
    const relax = Math.min(1, dt * 1.6);
    const GW = ParticleField.GW, GH = ParticleField.GH, grid = this.flowGrid, tmp: [number, number] = [0, 0];
    for (let j = 0; j <= GH; j++) for (let i = 0; i <= GW; i++) {
      curlFlow(i / GW, j / GH, t, tmp);
      const o = (i + j * (GW + 1)) * 2; grid[o] = tmp[0]; grid[o + 1] = tmp[1];
    }
    const gx = GW / w, gy = GH / h, stride = (GW + 1) * 2;
    const wx = wells.map(g => g.x), wy = wells.map(g => g.y), wm = wells.map(g => g.m * gravity);
    for (let i = 0; i < n; i++) {
      let xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i];
      const fgx = Math.min(GW - 1e-3, Math.max(0, xi * gx)), fgy = Math.min(GH - 1e-3, Math.max(0, yi * gy));
      const ci = fgx | 0, cj = fgy | 0, fs = fgx - ci, ft = fgy - cj, o0 = ci * 2 + cj * stride, o1 = o0 + stride;
      const flowX = (1 - ft) * ((1 - fs) * grid[o0] + fs * grid[o0 + 2]) + ft * ((1 - fs) * grid[o1] + fs * grid[o1 + 2]);
      const flowY = (1 - ft) * ((1 - fs) * grid[o0 + 1] + fs * grid[o0 + 3]) + ft * ((1 - fs) * grid[o1 + 1] + fs * grid[o1 + 3]);
      let ax = 0, ay = 0;
      for (let q = 0; q < 3; q++) {
        const dx = wx[q] - xi, dy = wy[q] - yi, r2 = dx * dx + dy * dy + soft;
        const inv = wm[q] / (r2 * Math.sqrt(r2));
        ax += dx * inv - dy * inv * 0.55; // pull plus a tangential swirl
        ay += dy * inv + dx * inv * 0.55;
      }
      if (px === px) {
        const dx = px - xi, dy = py - yi, r = Math.sqrt(dx * dx + dy * dy) + 1e-3;
        // Repel inside the reach, gently attract outside it: an orbit-able shell around the pointer.
        const push = r < reach ? -((1 - r / reach) ** 2) * 9000 : 700 * Math.exp(-(r - reach) / (0.35 * h));
        ax += (dx / r) * push; ay += (dy / r) * push;
      }
      const amag = Math.sqrt(ax * ax + ay * ay), cap = 2600;
      if (amag > cap) { ax *= cap / amag; ay *= cap / amag; }
      vxi += ax * dt + (flowX * flowScale - vxi) * relax;
      vyi += ay * dt + (flowY * flowScale - vyi) * relax;
      const sp = Math.sqrt(vxi * vxi + vyi * vyi), maxSp = 0.9 * h;
      if (sp > maxSp) { vxi *= maxSp / sp; vyi *= maxSp / sp; }
      xi += vxi * dt; yi += vyi * dt;
      vx[i] = vxi; vy[i] = vyi; x[i] = xi; y[i] = yi;
      life[i] -= dt;
      if (life[i] <= 0 || xi < 0 || yi < 0 || xi >= w || yi >= h || !(xi === xi)) this.respawn(i);
    }
  }
  private buildPalette(busy: boolean) {
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = hslToRgb(hueFor(i / 255, busy), 0.9, 0.55);
      this.palette[i * 3] = r; this.palette[i * 3 + 1] = g; this.palette[i * 3 + 2] = b;
    }
    this.paletteBusy = busy;
  }
  /** Fade the RGBA buffer (alpha stays opaque) then add every particle as a glowing point. */
  render(data: Uint8ClampedArray, dt: number, busy: boolean) {
    if (this.paletteBusy !== busy) this.buildPalette(busy);
    // Fade each channel by 1/8 per frame using one 32-bit operation per pixel (alpha untouched).
    void dt;
    const px = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let i = 0; i < px.length; i++) { const v = px[i]; px[i] = v - ((v >>> 3) & 0x001f1f1f); }
    const { n, w, h, x, y, vx, vy, tint, palette } = this;
    const iw = Math.floor(w), ih = Math.floor(h);
    for (let i = 0; i < n; i++) {
      const ix = x[i] | 0, iy = y[i] | 0;
      if (ix < 0 || iy < 0 || ix >= iw || iy >= ih) continue;
      const ci = Math.min(255, (tint[i] >> 1) + Math.min(127, Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * 0.35)) | 0;
      const o = (iy * iw + ix) * 4, k = ci * 3;
      data[o] += palette[k] * 0.27; data[o + 1] += palette[k + 1] * 0.27; data[o + 2] += palette[k + 2] * 0.27;
    }
  }
}

/* ---------------------------------------------------------------------- fluid */

export class Fluid {
  readonly w: number; readonly h: number;
  u: Float32Array; v: Float32Array; u0: Float32Array; v0: Float32Array;
  p: Float32Array; div: Float32Array; curl: Float32Array;
  dye: Float32Array[]; dye0: Float32Array[];
  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    const make = () => new Float32Array(w * h);
    this.u = make(); this.v = make(); this.u0 = make(); this.v0 = make();
    this.p = make(); this.div = make(); this.curl = make();
    this.dye = [make(), make(), make()]; this.dye0 = [make(), make(), make()];
  }
  /** Gaussian impulse of velocity (cells/s) and dye at a position in [0,1]². */
  splat(px: number, py: number, fx: number, fy: number, color: [number, number, number], radius = 0.045) {
    const { w, h } = this;
    const cx = px * (w - 1), cy = py * (h - 1), r = radius * w, inv = 1 / (r * r);
    const x0 = Math.max(0, Math.floor(cx - 3 * r)), x1 = Math.min(w - 1, Math.ceil(cx + 3 * r));
    const y0 = Math.max(0, Math.floor(cy - 3 * r)), y1 = Math.min(h - 1, Math.ceil(cy + 3 * r));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const g = Math.exp(-((i - cx) ** 2 + (j - cy) ** 2) * inv), k = i + j * w;
      this.u[k] += fx * g; this.v[k] += fy * g;
      this.dye[0][k] += color[0] * g; this.dye[1][k] += color[1] * g; this.dye[2][k] += color[2] * g;
    }
  }
  private advect(dst: Float32Array, src: Float32Array, dt: number, u: Float32Array, v: Float32Array) {
    const { w, h } = this;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = i + j * w;
      const x = clamp(i - dt * u[k], 0, w - 1.001), y = clamp(j - dt * v[k], 0, h - 1.001);
      const i0 = x | 0, j0 = y | 0, s = x - i0, t = y - j0, a = i0 + j0 * w;
      dst[k] = (1 - t) * ((1 - s) * src[a] + s * src[a + 1]) + t * ((1 - s) * src[a + w] + s * src[a + w + 1]);
    }
  }
  /** Remove the divergent part of the velocity field (pressure projection, Jacobi). */
  project(iterations = 24) {
    const { w, h, u, v, p, div } = this;
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      div[k] = -0.5 * (u[k + 1] - u[k - 1] + v[k + w] - v[k - w]);
    }
    for (let it = 0; it < iterations; it++) {
      for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
        const k = i + j * w;
        p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - w] + p[k + w]) * 0.25;
      }
    }
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = i + j * w;
      u[k] -= 0.5 * (p[k + 1] - p[k - 1]); v[k] -= 0.5 * (p[k + w] - p[k - w]);
    }
    // Solid walls: no flow through the boundary.
    for (let i = 0; i < w; i++) { v[i] = 0; v[i + (h - 1) * w] = 0; }
    for (let j = 0; j < h; j++) { u[j * w] = 0; u[w - 1 + j * w] = 0; }
  }
  /** Mean absolute divergence over the interior; a solver-health measure used by tests. */
  divergence(): number {
    const { w, h, u, v } = this;
    let sum = 0;
    for (let j = 2; j < h - 2; j++) for (let i = 2; i < w - 2; i++) {
      const k = i + j * w; sum += Math.abs(0.5 * (u[k + 1] - u[k - 1] + v[k + w] - v[k - w]));
    }
    return sum / ((w - 4) * (h - 4));
  }
  step(dt: number, vorticity = 6) {
    const { w, h, u, v, curl } = this;
    // Vorticity confinement keeps small eddies alive so the smoke keeps curling.
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = i + j * w; curl[k] = 0.5 * (v[k + 1] - v[k - 1] - (u[k + w] - u[k - w]));
    }
    for (let j = 2; j < h - 2; j++) for (let i = 2; i < w - 2; i++) {
      const k = i + j * w;
      const gx = 0.5 * (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1])), gy = 0.5 * (Math.abs(curl[k + w]) - Math.abs(curl[k - w]));
      const len = Math.hypot(gx, gy) + 1e-5;
      u[k] += (gy / len) * curl[k] * vorticity * dt; v[k] -= (gx / len) * curl[k] * vorticity * dt;
    }
    this.project();
    this.u0.set(u); this.v0.set(v);
    this.advect(u, this.u0, dt, this.u0, this.v0); this.advect(v, this.v0, dt, this.u0, this.v0);
    this.project();
    const decay = Math.pow(0.992, dt * 60), drag = Math.pow(0.999, dt * 60);
    for (let c = 0; c < 3; c++) {
      this.advect(this.dye0[c], this.dye[c], dt, u, v);
      const d = this.dye[c], d0 = this.dye0[c];
      for (let k = 0; k < d.length; k++) d[k] = d0[k] * decay;
    }
    for (let k = 0; k < u.length; k++) { u[k] *= drag; v[k] *= drag; }
  }
  render(data: Uint8ClampedArray) {
    const [r, g, b] = this.dye;
    for (let k = 0, o = 0; k < r.length; k++, o += 4) {
      data[o] = (1 - Math.exp(-1.2 * r[k])) * 255; data[o + 1] = (1 - Math.exp(-1.2 * g[k])) * 255;
      data[o + 2] = (1 - Math.exp(-1.2 * b[k])) * 255; data[o + 3] = 255;
    }
  }
}

/* ----------------------------------------------------------------- matrix rain */

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>¦";
export class MatrixRain {
  cols = 0; rows = 0;
  head = new Float32Array(0); speed = new Float32Array(0); drawn = new Int32Array(0); prev = new Uint16Array(0);
  constructor(private cell = 16, private rand: () => number = Math.random) {}
  resize(w: number, h: number) {
    this.cols = Math.max(1, Math.floor(w / this.cell)); this.rows = Math.max(1, Math.floor(h / this.cell));
    this.head = new Float32Array(this.cols); this.speed = new Float32Array(this.cols);
    this.drawn = new Int32Array(this.cols).fill(-1); this.prev = new Uint16Array(this.cols);
    for (let c = 0; c < this.cols; c++) this.reset(c, true);
  }
  private reset(c: number, initial = false) {
    this.head[c] = initial ? this.rand() * this.rows : -this.rand() * this.rows * 0.6;
    this.speed[c] = 7 + this.rand() * 18; this.drawn[c] = Math.floor(this.head[c]) - 1;
  }
  glyph() { return Math.floor(this.rand() * GLYPHS.length); }
  frame(ctx: CanvasRenderingContext2D, dt: number, busy: boolean, pointer?: Pointer) {
    const { cell, cols, rows } = this;
    ctx.fillStyle = `rgba(0,6,2,${Math.min(0.5, 0.07 * dt * 60)})`;
    ctx.fillRect(0, 0, cols * cell, rows * cell + cell);
    ctx.font = `${cell}px monospace`; ctx.textBaseline = "top";
    const pc = pointer?.active ? pointer.x * cols : -99;
    for (let c = 0; c < cols; c++) {
      const boost = Math.abs(c - pc) < 5 ? 2.2 : 1;
      this.head[c] += this.speed[c] * (busy ? 1.4 : 1) * boost * dt;
      const row = Math.floor(this.head[c]);
      if (row !== this.drawn[c] && row >= 0 && row < rows) {
        const x = c * cell;
        if (this.drawn[c] >= 0) { ctx.fillStyle = busy ? "#3cff9a" : "#12d45a"; ctx.fillText(GLYPHS[this.prev[c]], x, this.drawn[c] * cell); }
        const g = this.glyph(); this.prev[c] = g;
        ctx.fillStyle = "#dfffe9"; ctx.fillText(GLYPHS[g], x, row * cell);
        this.drawn[c] = row;
      }
      if (this.head[c] > rows + 2) this.reset(c);
    }
  }
}

/* -------------------------------------------------------- canvas-bound effects */

function particleEffect(canvas: HTMLCanvasElement, q: Quality): Effect | undefined {
  const ctx = canvas.getContext("2d"); const off = document.createElement("canvas"); const octx = off.getContext("2d");
  if (!ctx || !octx) return undefined;
  let field: ParticleField | undefined, img: ImageData | undefined, W = 0, H = 0;
  return {
    resize(width, height, dpr = 1) {
      ({ w: W, h: H } = setupCanvas(canvas, ctx, width, height, dpr));
      const scale = q.particleScale * Math.min(dpr, 1.5);
      off.width = Math.max(2, Math.floor(W * scale)); off.height = Math.max(2, Math.floor(H * scale));
      img = octx.createImageData(off.width, off.height);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      if (field) field.resize(off.width, off.height); else field = new ParticleField(q.particles, off.width, off.height);
    },
    frame(dt, t, { busy, pointer }) {
      if (!field || !img) return;
      field.step(dt, t, busy, pointer);
      field.render(img.data, dt, busy); octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(off, 0, 0, W, H);
    },
    dispose() { field = undefined; img = undefined; },
  };
}

function smokeEffect(canvas: HTMLCanvasElement, q: Quality): Effect | undefined {
  const ctx = canvas.getContext("2d"); const off = document.createElement("canvas"); const octx = off.getContext("2d");
  if (!ctx || !octx) return undefined;
  let fluid: Fluid | undefined, img: ImageData | undefined, last: Pointer | undefined, W = 0, H = 0;
  return {
    resize(width, height, dpr = 1) {
      ({ w: W, h: H } = setupCanvas(canvas, ctx, width, height, dpr));
      const gw = q.smokeWidth, gh = Math.max(24, Math.round(gw * H / W));
      off.width = gw; off.height = gh; fluid = new Fluid(gw, gh); img = octx.createImageData(gw, gh);
    },
    frame(dt, t, { busy, pointer }) {
      if (!fluid || !img) return;
      for (let k = 0; k < 3; k++) {
        const a = 0.37 * t + k * 2.1, b = 0.53 * t + k * 1.3;
        const x = 0.5 + 0.38 * Math.sin(a), y = 0.5 + 0.34 * Math.cos(b);
        const vx = 0.38 * 0.37 * Math.cos(a), vy = -0.34 * 0.53 * Math.sin(b);
        const [r, g, bl] = hslToRgb(hueFor(((t * 0.04 + k / 3) % 1 + 1) % 1, busy), 0.9, 0.55);
        fluid.splat(x, y, vx * fluid.w * 6 * (busy ? 1.5 : 1), vy * fluid.w * 6 * (busy ? 1.5 : 1), [r / 255 * dt * 18, g / 255 * dt * 18, bl / 255 * dt * 18]);
      }
      if (pointer?.active) {
        const dx = last?.active ? pointer.x - last.x : 0, dy = last?.active ? pointer.y - last.y : 0;
        const [r, g, bl] = hslToRgb(hueFor((t * 0.1) % 1, busy), 0.95, 0.6);
        fluid.splat(pointer.x, pointer.y, dx * fluid.w * 40, dy * fluid.w * 40, [r / 255 * 0.5, g / 255 * 0.5, bl / 255 * 0.5], 0.05);
      }
      last = pointer ? { ...pointer } : undefined;
      fluid.step(Math.min(dt, 0.033) * 2.4);
      fluid.render(img.data); octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(off, 0, 0, W, H);
    },
    dispose() { fluid = undefined; img = undefined; },
  };
}

function matrixEffect(canvas: HTMLCanvasElement): Effect | undefined {
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  const rain = new MatrixRain(16);
  return {
    resize(width, height, dpr = 1) {
      const { w, h } = setupCanvas(canvas, ctx, width, height, dpr);
      ctx.fillStyle = "#000602"; ctx.fillRect(0, 0, w, h); rain.resize(w, h);
    },
    frame(dt, _t, { busy, pointer }) { rain.frame(ctx, dt, busy, pointer); },
    dispose() {},
  };
}

export function createEffect(mode: EffectMode, canvas: HTMLCanvasElement, q: Quality = qualityFor("high")): Effect | undefined {
  try {
    if (mode === "particles") return particleEffect(canvas, q);
    if (mode === "smoke") return smokeEffect(canvas, q);
    if (mode === "matrix") return matrixEffect(canvas);
    if (mode === "attractor") return attractorEffect(canvas, q);
    if (mode === "wavegrid") return waveGridEffect(canvas);
    if (mode === "starfield") return starfieldEffect(canvas, q);
    if (mode === "threebody") return threeBodyEffect(canvas);
    if (mode === "proton") return protonEffect(canvas);
  } catch { /* A broken canvas must never affect the application underneath. */ }
  return undefined;
}
