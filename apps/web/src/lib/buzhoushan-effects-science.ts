/**
 * Science-themed broadcast screensaver effects. Each model is a headless class (unit-testable)
 * plus a thin canvas wrapper:
 *  - LorenzCloud: thousands of orbits of the Lorenz strange attractor (RK2), rotating camera.
 *  - WaveSurface: travelling-wave height field flown over as a hidden-line wireframe.
 *  - Starfield: perspective warp through a 3D star volume.
 *  - ThreeBody: Newtonian three-sun problem (velocity Verlet) from a perturbed figure-eight.
 *  - ProtonModel: uud valence quarks, colour-charge flux tubes and a fizzing quark–antiquark sea.
 */
import { TAU, clamp, hslToRgb, hueFor, setupCanvas, type Effect, type Quality } from "./buzhoushan-effect-common";

type Rand = () => number;

/* ----------------------------------------------------------- Lorenz attractor */

export class LorenzCloud {
  x: Float32Array; y: Float32Array; z: Float32Array;
  constructor(readonly n: number, private rand: Rand = Math.random) {
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.reseed(i);
      for (let s = 0, steps = Math.floor(rand() * 400); s < steps; s++) this.advance(i, 0.01);
    }
  }
  private reseed(i: number) {
    this.x[i] = 1 + (this.rand() - 0.5) * 2; this.y[i] = 1 + (this.rand() - 0.5) * 2; this.z[i] = 20 + (this.rand() - 0.5) * 2;
  }
  private advance(i: number, h: number) {
    const sigma = 10, rho = 28, beta = 8 / 3;
    const x = this.x[i], y = this.y[i], z = this.z[i];
    const dx = sigma * (y - x), dy = x * (rho - z) - y, dz = x * y - beta * z;
    const mx = x + 0.5 * h * dx, my = y + 0.5 * h * dy, mz = z + 0.5 * h * dz;
    this.x[i] = x + h * sigma * (my - mx);
    this.y[i] = y + h * (mx * (rho - mz) - my);
    this.z[i] = z + h * (mx * my - beta * mz);
    if (!(Math.abs(this.x[i]) < 100 && Math.abs(this.y[i]) < 100 && Math.abs(this.z[i]) < 150)) this.reseed(i);
  }
  step(h: number) { for (let i = 0; i < this.n; i++) this.advance(i, h); }
}

export function attractorEffect(canvas: HTMLCanvasElement, q: Quality): Effect | undefined {
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  const cloud = new LorenzCloud(q.attractor);
  const BUCKETS = 14;
  const paths: [number, number, number][][] = Array.from({ length: BUCKETS }, () => []);
  let w = 0, h = 0;
  return {
    resize(width, height, dpr = 1) { ({ w, h } = setupCanvas(canvas, ctx, width, height, dpr)); ctx.fillStyle = "#02040a"; ctx.fillRect(0, 0, w, h); },
    frame(dt, t, { busy, pointer }) {
      for (let s = 0; s < 3; s++) cloud.step(0.0045 * (busy ? 1.5 : 1) * Math.min(1, dt * 60));
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgba(2,4,10,${Math.min(0.5, 0.09 * dt * 60)})`; ctx.fillRect(0, 0, w, h);
      const yaw = t * 0.22 + (pointer?.active ? (pointer.x - 0.5) * 2 : 0), pitch = 0.35 + 0.15 * Math.sin(t * 0.13) + (pointer?.active ? (pointer.y - 0.5) * 0.8 : 0);
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const S = h * 0.0185, cx = w / 2, cyy = h * 0.5;
      for (const p of paths) p.length = 0;
      for (let i = 0; i < cloud.n; i++) {
        const x0 = cloud.x[i], y0 = cloud.y[i], z0 = cloud.z[i] - 25;
        const x1 = x0 * cy - y0 * sy, y1 = x0 * sy + y0 * cy;
        const y2 = y1 * cp - z0 * sp, z2 = y1 * sp + z0 * cp;
        const f = 1 / (1 + y2 * 0.012), sx = cx + x1 * S * f * 1.15, sY = cyy - z2 * S * f;
        const speed = Math.abs(cloud.x[i] * cloud.y[i]) / 40;
        const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(clamp(speed, 0, 1) * (BUCKETS - 1))));
        paths[b].push([sx, sY, f]);
      }
      ctx.globalCompositeOperation = "lighter";
      for (let b = 0; b < BUCKETS; b++) {
        const [r, g, bl] = hslToRgb(hueFor(b / (BUCKETS - 1), busy), 0.95, 0.58);
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},0.62)`;
        ctx.beginPath();
        for (const [px, py, f] of paths[b]) ctx.rect(px, py, 1.4 * f + 0.6, 1.4 * f + 0.6);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}

/* -------------------------------------------------------------- wave surface */

/** Height of a sum of travelling waves plus a radial ripple around an optional pointer. */
export function waveHeight(x: number, z: number, t: number, bump?: { x: number; z: number }): number {
  let y = 0.55 * Math.sin(0.9 * x + 0.7 * t) * Math.sin(0.55 * z - 0.5 * t)
    + 0.32 * Math.sin(0.5 * x - 0.42 * z + 0.9 * t)
    + 0.22 * Math.sin(1.7 * z + 1.3 * t + 0.3 * x);
  if (bump) { const d2 = (x - bump.x) ** 2 + (z - bump.z) ** 2; y += 1.1 * Math.exp(-d2 / 5) * Math.cos(2.8 * Math.sqrt(d2) - 4.5 * t); }
  return y;
}

export function waveGridEffect(canvas: HTMLCanvasElement): Effect | undefined {
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  const COLS = 84, ROWS = 64, DZ = 0.6, XR = 13, CAM_H = 5.2, AMP = 1.7;
  let w = 0, h = 0;
  const cur = new Float32Array((COLS + 1) * 2), prev = new Float32Array((COLS + 1) * 2);
  return {
    resize(width, height, dpr = 1) { ({ w, h } = setupCanvas(canvas, ctx, width, height, dpr)); },
    frame(_dt, t, { busy, pointer }) {
      const horizon = h * 0.36, focal = w * 0.06, speed = busy ? 3.2 : 1.8, cam = t * speed;
      const base = Math.floor(cam / DZ) * DZ, hue = busy ? 140 : 195;
      const sky = ctx.createLinearGradient(0, 0, 0, horizon + 40);
      sky.addColorStop(0, "#02030a"); sky.addColorStop(1, busy ? "#04281a" : "#0a1f46");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w / 2, horizon, 0, w / 2, horizon, w * 0.5);
      glow.addColorStop(0, busy ? "rgba(80,255,170,.35)" : "rgba(120,170,255,.38)"); glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, horizon + 60);
      const bump = pointer?.active ? { x: (pointer.x - 0.5) * 2 * XR * 0.8, z: base + (1 - pointer.y) * ROWS * DZ * 0.5 } : undefined;
      ctx.lineJoin = "round";
      for (let row = ROWS - 1; row >= 0; row--) {
        const zw = base + row * DZ, d = zw - cam;
        if (d < -0.4) continue;
        const k = focal / (d + 1), depth = clamp(d / (ROWS * DZ), 0, 1);
        for (let c = 0; c <= COLS; c++) {
          const X = (c / COLS - 0.5) * 2 * XR, Y = AMP * waveHeight(X, zw, t, bump);
          cur[c * 2] = w / 2 + X * k; cur[c * 2 + 1] = horizon + (CAM_H - Y) * k;
        }
        // Hidden-line removal: everything below this ridge hides what lies behind it.
        ctx.beginPath(); ctx.moveTo(0, cur[1]); ctx.lineTo(cur[0], cur[1]);
        for (let c = 1; c <= COLS; c++) ctx.lineTo(cur[c * 2], cur[c * 2 + 1]);
        ctx.lineTo(w, cur[COLS * 2 + 1]); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = "#02050c"; ctx.fill();
        const alpha = (0.2 + 0.8 * (1 - depth) ** 1.3) * Math.min(1, (1 - depth) * 5);
        if (row < ROWS - 1) {
          ctx.strokeStyle = `hsla(${hue},90%,62%,${alpha * 0.38})`; ctx.lineWidth = 1; ctx.beginPath();
          for (let c = 0; c <= COLS; c += 2) { ctx.moveTo(prev[c * 2], prev[c * 2 + 1]); ctx.lineTo(cur[c * 2], cur[c * 2 + 1]); }
          ctx.stroke();
        }
        ctx.strokeStyle = `hsla(${hue + 20 * (1 - depth)},95%,${58 + 18 * (1 - depth)}%,${alpha})`; ctx.lineWidth = 1 + 0.9 * (1 - depth);
        ctx.beginPath(); ctx.moveTo(cur[0], cur[1]);
        for (let c = 1; c <= COLS; c++) ctx.lineTo(cur[c * 2], cur[c * 2 + 1]);
        ctx.stroke();
        prev.set(cur);
      }
    },
    dispose() {},
  };
}

/* ------------------------------------------------------------------ starfield */

export class Starfield {
  x: Float32Array; y: Float32Array; z: Float32Array; temp: Float32Array;
  constructor(readonly n: number, private zMax = 40, private rand: Rand = Math.random) {
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n); this.temp = new Float32Array(n);
    for (let i = 0; i < n; i++) { this.respawn(i); this.z[i] = 0.5 + this.rand() * (zMax - 0.5); }
  }
  private respawn(i: number) {
    const a = this.rand() * TAU, r = 0.15 + Math.sqrt(this.rand()) * 1.6;
    this.x[i] = Math.cos(a) * r; this.y[i] = Math.sin(a) * r; this.z[i] = this.zMax; this.temp[i] = this.rand();
  }
  /** Fly forward by `dz` world units; stars passing the camera respawn far away. */
  step(dz: number) { for (let i = 0; i < this.n; i++) { this.z[i] -= dz; if (this.z[i] <= 0.2) this.respawn(i); } }
}

export function starfieldEffect(canvas: HTMLCanvasElement, q: Quality): Effect | undefined {
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  const field = new Starfield(q.stars);
  const far = Array.from({ length: 520 }, () => ({ x: Math.random(), y: Math.random(), p: Math.random() * TAU, s: 0.4 + Math.random() * 1.1 }));
  let w = 0, h = 0, nebula: HTMLCanvasElement | undefined;
  const paintNebula = () => {
    nebula = document.createElement("canvas"); nebula.width = w; nebula.height = h;
    const g = nebula.getContext("2d"); if (!g) return;
    g.fillStyle = "#01030a"; g.fillRect(0, 0, w, h);
    for (const [x, y, r, c] of [[0.3, 0.4, 0.5, "60,80,200"], [0.72, 0.62, 0.45, "150,60,190"], [0.55, 0.25, 0.35, "40,150,190"]] as const) {
      const grad = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * w);
      grad.addColorStop(0, `rgba(${c},.2)`); grad.addColorStop(1, `rgba(${c},0)`); g.fillStyle = grad; g.fillRect(0, 0, w, h);
    }
  };
  return {
    resize(width, height, dpr = 1) { ({ w, h } = setupCanvas(canvas, ctx, width, height, dpr)); paintNebula(); },
    frame(dt, t, { busy, pointer }) {
      const speed = busy ? 14 : 6.5;
      if (nebula) ctx.drawImage(nebula, 0, 0); else { ctx.fillStyle = "#01030a"; ctx.fillRect(0, 0, w, h); }
      ctx.globalCompositeOperation = "lighter";
      for (const s of far) { ctx.fillStyle = `rgba(200,220,255,${0.25 + 0.35 * Math.sin(t * 1.7 + s.p)})`; ctx.fillRect(s.x * w, s.y * h, s.s, s.s); }
      const roll = t * 0.05, cr = Math.cos(roll), sr = Math.sin(roll);
      const ox = w / 2 + (pointer?.active ? (0.5 - pointer.x) * w * 0.16 : 0), oy = h / 2 + (pointer?.active ? (0.5 - pointer.y) * h * 0.16 : 0);
      const f = h * 0.55, trail = speed * 0.06;
      ctx.lineCap = "round";
      for (let i = 0; i < field.n; i++) {
        const z = field.z[i], X = field.x[i] * cr - field.y[i] * sr, Y = field.x[i] * sr + field.y[i] * cr;
        const sx = ox + (X / z) * f, sy = oy + (Y / z) * f, zp = z + trail, px = ox + (X / zp) * f, py = oy + (Y / zp) * f;
        if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue;
        const near = 1 - z / 40, tp = field.temp[i];
        const [r, g, b] = hslToRgb(tp < 0.5 ? 215 - tp * 40 : 40 - (tp - 0.5) * 60, 0.75, 0.82);
        ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${clamp(near * 1.3, 0.08, 1)})`; ctx.lineWidth = 0.5 + near * 2.2;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx, sy); ctx.stroke();
      }
      field.step(speed * dt);
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() { nebula = undefined; },
  };
}

/* ----------------------------------------------------------------- three body */

export class ThreeBody {
  x = new Float64Array(3); y = new Float64Array(3); vx = new Float64Array(3); vy = new Float64Array(3);
  time = 0; lastClose = 0;
  constructor(private rand: Rand = Math.random, private eps = 0.04) { this.reseed(); }
  /** Chenciner–Montgomery figure-eight, perturbed so it eventually breaks into chaos. */
  reseed(perturb = 0.02 + this.rand() * 0.06) {
    const px = 0.97000436, py = -0.24308753, vx3 = -0.93240737, vy3 = -0.86473146;
    this.x.set([-px, px, 0]); this.y.set([-py, py, 0]);
    this.vx.set([-vx3 / 2, -vx3 / 2, vx3]); this.vy.set([-vy3 / 2, -vy3 / 2, vy3]);
    const rot = this.rand() * TAU, c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < 3; i++) {
      const jx = this.vx[i] + (this.rand() - 0.5) * perturb * 2, jy = this.vy[i] + (this.rand() - 0.5) * perturb * 2;
      const x = this.x[i], y = this.y[i];
      this.x[i] = x * c - y * s; this.y[i] = x * s + y * c; this.vx[i] = jx * c - jy * s; this.vy[i] = jx * s + jy * c;
    }
    // Remove the net momentum so the centre of mass stays put.
    const mvx = (this.vx[0] + this.vx[1] + this.vx[2]) / 3, mvy = (this.vy[0] + this.vy[1] + this.vy[2]) / 3;
    for (let i = 0; i < 3; i++) { this.vx[i] -= mvx; this.vy[i] -= mvy; }
    this.time = 0; this.lastClose = 0;
  }
  private accel(ax: Float64Array, ay: Float64Array) {
    ax.fill(0); ay.fill(0);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i], r2 = dx * dx + dy * dy + this.eps * this.eps;
      const inv = 1 / (r2 * Math.sqrt(r2));
      ax[i] += dx * inv; ay[i] += dy * inv; ax[j] -= dx * inv; ay[j] -= dy * inv;
    }
  }
  private ax = new Float64Array(3); private ay = new Float64Array(3);
  /** Velocity Verlet (symplectic, so energy stays bounded between close encounters). */
  step(h: number) {
    this.accel(this.ax, this.ay);
    for (let i = 0; i < 3; i++) { this.vx[i] += 0.5 * h * this.ax[i]; this.vy[i] += 0.5 * h * this.ay[i]; this.x[i] += h * this.vx[i]; this.y[i] += h * this.vy[i]; }
    this.accel(this.ax, this.ay);
    for (let i = 0; i < 3; i++) { this.vx[i] += 0.5 * h * this.ax[i]; this.vy[i] += 0.5 * h * this.ay[i]; }
    this.time += h;
    if (this.minDistance() < 0.3) this.lastClose = this.time;
  }
  energy(): number {
    let e = 0;
    for (let i = 0; i < 3; i++) e += 0.5 * (this.vx[i] ** 2 + this.vy[i] ** 2);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) e -= 1 / Math.sqrt((this.x[j] - this.x[i]) ** 2 + (this.y[j] - this.y[i]) ** 2 + this.eps * this.eps);
    return e;
  }
  minDistance(): number {
    let m = Infinity;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) m = Math.min(m, Math.hypot(this.x[j] - this.x[i], this.y[j] - this.y[i]));
    return m;
  }
  center(): [number, number] { return [(this.x[0] + this.x[1] + this.x[2]) / 3, (this.y[0] + this.y[1] + this.y[2]) / 3]; }
  extent(): number { const [cx, cy] = this.center(); let m = 0; for (let i = 0; i < 3; i++) m = Math.max(m, Math.hypot(this.x[i] - cx, this.y[i] - cy)); return m; }
}

export function threeBodyEffect(canvas: HTMLCanvasElement): Effect | undefined {
  const ctx = canvas.getContext("2d"); const trail = document.createElement("canvas"); const tctx = trail.getContext("2d");
  if (!ctx || !tctx) return undefined;
  const sim = new ThreeBody();
  const suns = [{ r: 255, g: 170, b: 70, size: 1.1 }, { r: 255, g: 244, b: 205, size: 1.3 }, { r: 255, g: 105, b: 80, size: 0.95 }];
  let w = 0, h = 0, cx = 0, cy = 0, zoom = 120, acc = 0;
  const last: ([number, number] | undefined)[] = [undefined, undefined, undefined];
  const reset = () => {
    sim.reseed(); tctx.fillStyle = "#01020a"; tctx.fillRect(0, 0, w, h); last.fill(undefined);
    for (let i = 0; i < 160; i++) { tctx.fillStyle = `rgba(190,205,255,${0.15 + Math.random() * 0.35})`; tctx.fillRect(Math.random() * w, Math.random() * h, 1.2, 1.2); }
  };
  return {
    resize(width, height, dpr = 1) { ({ w, h } = setupCanvas(canvas, ctx, width, height, dpr)); trail.width = canvas.width; trail.height = canvas.height; tctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0); zoom = Math.min(w, h) * 0.3; reset(); },
    frame(dt, _t, { busy }) {
      acc += dt * (busy ? 1.9 : 1.2);
      for (let steps = 0; acc >= 0.003 && steps < 220; steps++) { sim.step(0.003); acc -= 0.003; }
      if (acc > 0.05) acc = 0;
      if (!(sim.extent() < 9)) reset();
      const [mx, my] = sim.center(), target = Math.min(w, h) * 0.4 / (sim.extent() + 0.8);
      cx += (mx - cx) * Math.min(1, dt * 2); cy += (my - cy) * Math.min(1, dt * 2); zoom += (target - zoom) * Math.min(1, dt * 1.2);
      tctx.fillStyle = `rgba(1,2,10,${Math.min(0.4, 0.011 * dt * 60)})`; tctx.fillRect(0, 0, w, h);
      tctx.globalCompositeOperation = "lighter"; tctx.lineCap = "round";
      const pos: [number, number][] = [];
      for (let i = 0; i < 3; i++) {
        const sx = w / 2 + (sim.x[i] - cx) * zoom, sy = h / 2 + (sim.y[i] - cy) * zoom; pos.push([sx, sy]);
        const prev = last[i], s = suns[i];
        if (prev && Math.hypot(sx - prev[0], sy - prev[1]) < w / 3) {
          tctx.strokeStyle = `rgba(${s.r},${s.g},${s.b},0.9)`; tctx.lineWidth = 2.6;
          tctx.beginPath(); tctx.moveTo(prev[0], prev[1]); tctx.lineTo(sx, sy); tctx.stroke();
        }
        last[i] = [sx, sy];
      }
      tctx.globalCompositeOperation = "source-over";
      ctx.drawImage(trail, 0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 3; i++) {
        const [sx, sy] = pos[i], s = suns[i], R = (16 + 7 * s.size) * (zoom / (Math.min(w, h) * 0.3)) ** 0.25;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 3.2);
        g.addColorStop(0, `rgba(255,255,255,1)`); g.addColorStop(0.16, `rgba(${s.r},${s.g},${s.b},0.95)`);
        g.addColorStop(0.45, `rgba(${s.r},${s.g},${s.b},0.22)`); g.addColorStop(1, `rgba(${s.r},${s.g},${s.b},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, R * 3.2, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}

/* --------------------------------------------------------------------- proton */

const QUARKS = [
  { name: "u", rgb: [255, 70, 70] }, { name: "u", rgb: [70, 255, 110] }, { name: "d", rgb: [80, 140, 255] },
] as const;

export type SeaPair = { x: number; y: number; z: number; dx: number; dy: number; dz: number; age: number; life: number; hue: number };

export class ProtonModel {
  pairs: SeaPair[] = [];
  cloud: { ox: number; oy: number; oz: number; p: number; s: number }[];
  private spawnDebt = 0;
  constructor(cloudSize = 900, private rand: Rand = Math.random) {
    const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rand(); return (s - 2) * 1.2; };
    this.cloud = Array.from({ length: cloudSize }, () => ({ ox: gauss() * 0.7, oy: gauss() * 0.7, oz: gauss() * 0.7, p: rand() * TAU, s: 0.5 + rand() * 1.5 }));
  }
  /** Valence quark positions in model units (the proton radius is about 1). */
  quark(k: number, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const a = (TAU * k) / 3 + 0.9 * t + 0.35 * Math.sin(1.7 * t + k), r = 0.62 + 0.2 * Math.sin(2.3 * t + k * 1.7);
    out[0] = Math.cos(a) * r; out[1] = 0.42 * Math.sin(1.3 * t + k * 2.1); out[2] = Math.sin(a) * r;
    return out;
  }
  /** Spawn and age virtual quark–antiquark pairs; each lives a fraction of a second then annihilates. */
  update(dt: number) {
    this.spawnDebt += dt * 22;
    while (this.spawnDebt >= 1 && this.pairs.length < 60) {
      this.spawnDebt -= 1;
      const u = this.rand() * TAU, v = this.rand() * 2 - 1, r = 1.05 * Math.cbrt(this.rand()), s = Math.sqrt(1 - v * v);
      const a = this.rand() * TAU, b = this.rand() * 2 - 1, bs = Math.sqrt(1 - b * b);
      this.pairs.push({ x: r * s * Math.cos(u), y: r * v, z: r * s * Math.sin(u), dx: bs * Math.cos(a), dy: b, dz: bs * Math.sin(a), age: 0, life: 0.45 + this.rand() * 0.7, hue: this.rand() * 360 });
    }
    this.spawnDebt = Math.min(this.spawnDebt, 3);
    for (const p of this.pairs) p.age += dt;
    this.pairs = this.pairs.filter(p => p.age < p.life);
  }
}

export function protonEffect(canvas: HTMLCanvasElement): Effect | undefined {
  const ctx = canvas.getContext("2d"); if (!ctx) return undefined;
  const model = new ProtonModel();
  let w = 0, h = 0;
  const q = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][];
  return {
    resize(width, height, dpr = 1) { ({ w, h } = setupCanvas(canvas, ctx, width, height, dpr)); ctx.fillStyle = "#02030a"; ctx.fillRect(0, 0, w, h); },
    frame(dt, t, { busy, pointer }) {
      model.update(dt);
      const yaw = t * 0.32 + (pointer?.active ? (pointer.x - 0.5) * 2 : 0), pitch = 0.42 + (pointer?.active ? (pointer.y - 0.5) * 0.8 : 0);
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), S = Math.min(w, h) * 0.34;
      const project = (x: number, y: number, z: number): [number, number, number] => {
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy, y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, f = 1 / (1 + z2 * 0.16);
        return [w / 2 + x1 * S * f, h / 2 - y2 * S * f, f];
      };
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgba(2,3,10,${Math.min(0.6, 0.38 * dt * 60)})`; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, S * 1.5);
      halo.addColorStop(0, busy ? "rgba(60,200,140,.14)" : "rgba(90,110,255,.14)"); halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
      // Probability cloud of the bag.
      ctx.fillStyle = busy ? "rgba(150,255,200,.35)" : "rgba(170,190,255,.32)"; ctx.beginPath();
      for (const c of model.cloud) {
        const [px, py, f] = project(c.ox + 0.12 * Math.sin(2.1 * t + c.p), c.oy + 0.12 * Math.sin(1.7 * t + c.p * 1.3), c.oz + 0.12 * Math.cos(1.9 * t + c.p));
        ctx.rect(px, py, c.s * f, c.s * f);
      }
      ctx.fill();
      for (let k = 0; k < 3; k++) model.quark(k, t, q[k]);
      // Gluon flux tubes: wavy colour-field lines from each quark to the Y-junction at the centre.
      for (let k = 0; k < 3; k++) {
        const [qx, qy, qz] = q[k], [r, g, b] = QUARKS[k].rgb;
        const pts: [number, number][] = [];
        for (let i = 0; i <= 28; i++) {
          const s = i / 28, env = Math.sin(Math.PI * s) * 0.09, ph = 12 * s - 7 * t + k * 2;
          const [px, py] = project(qx * (1 - s) + env * Math.sin(ph), qy * (1 - s) + env * Math.cos(ph * 0.9), qz * (1 - s) + env * Math.sin(ph * 1.3));
          pts.push([px, py]);
        }
        for (const [lw, a] of [[9, 0.1], [3.2, 0.35], [1.2, 0.9]] as const) {
          ctx.strokeStyle = `rgba(${r},${g},${b},${a})`; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        }
        for (let j = 0; j < 5; j++) {
          const s = (t * 0.7 + j / 5 + k / 3) % 1, [px, py, f] = project(qx * (1 - s), qy * (1 - s), qz * (1 - s));
          ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.beginPath(); ctx.arc(px, py, 1.8 * f, 0, TAU); ctx.fill();
        }
      }
      // Virtual sea: quark–antiquark pairs separate, then annihilate in a flash.
      for (const p of model.pairs) {
        const tau = p.age / p.life, sep = 0.15 * Math.sin(Math.PI * tau), [r, g, b] = hslToRgb(p.hue, 0.9, 0.6);
        const a = project(p.x + p.dx * sep, p.y + p.dy * sep, p.z + p.dz * sep), c = project(p.x - p.dx * sep, p.y - p.dy * sep, p.z - p.dz * sep);
        ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},.4)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},.9)`; ctx.beginPath(); ctx.arc(a[0], a[1], 2.2 * a[2], 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${255 - r | 0},${255 - g | 0},${255 - b | 0},.9)`; ctx.beginPath(); ctx.arc(c[0], c[1], 2.2 * c[2], 0, TAU); ctx.fill();
        if (tau > 0.9) { const m = project(p.x, p.y, p.z), fl = (tau - 0.9) * 10; ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - fl)})`; ctx.beginPath(); ctx.arc(m[0], m[1], 3 + 14 * fl, 0, TAU); ctx.fill(); }
      }
      // Valence quarks, drawn last as bright colour-charge cores.
      for (let k = 0; k < 3; k++) {
        const [px, py, f] = project(q[k][0], q[k][1], q[k][2]), [r, g, b] = QUARKS[k].rgb, R = 40 * f;
        const grad = ctx.createRadialGradient(px, py, 0, px, py, R);
        grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.25, `rgba(${r},${g},${b},.95)`); grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(px, py, R, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}
