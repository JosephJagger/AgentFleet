import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How long a global voice call survives a dropped browser signaling socket. The audio travels over WebRTC
 * and the host keeps its own watchdog, so a short network blip need not end the call. The browser stops
 * retrying a few seconds earlier so it never resumes into an already expired call.
 */
export const PANEL_RESUME_GRACE_MS = 30_000;
const MAX_QUEUED = 400;
const OPEN = 1;
/** Messages that must survive a full queue: they change what the browser must do or show. */
const CRITICAL = new Set(["answer", "recovering", "recovered", "closed", "error", "resumed"]);

/** The slice of a WebSocket the call code uses. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const messageType = (data: string): string => { try { return String(JSON.parse(data).type ?? ""); } catch { return ""; } };

/**
 * The browser end of one global voice call. While its signaling socket is connected it behaves like that
 * socket. When the socket drops it keeps accepting messages into a bounded queue for a grace period; a
 * browser that proves it owns the call (secret resume token, rotated on every use) re-attaches a new socket,
 * receives the queued messages in order, and the call carries on. Otherwise the grace timer ends the call.
 * Channels created without `resumable` behave exactly like the plain socket they wrap.
 */
export class PanelChannel {
  private raw: SocketLike | null;
  private queue: string[] = [];
  private token: string | undefined;
  private since: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  resumes = 0;

  constructor(raw: SocketLike, readonly resumable = false) {
    this.raw = raw;
    if (resumable) this.token = randomBytes(24).toString("hex");
  }

  /** A detached channel reports OPEN so queued sends are accepted; an ended one reports CLOSED. */
  get readyState(): number { return this.raw ? this.raw.readyState : this.detached ? OPEN : 3; }
  get detached(): boolean { return this.raw === null && this.since !== undefined && !this.ended; }
  get detachedAt(): number | undefined { return this.detached ? this.since : undefined; }
  get queued(): number { return this.queue.length; }
  currentToken(): string | undefined { return this.token; }
  isCurrent(raw: SocketLike): boolean { return this.raw === raw; }

  send(data: string): void {
    if (this.raw) { this.raw.send(data); return; }
    if (!this.detached) throw new Error("Panel channel is closed");
    if (this.queue.length >= MAX_QUEUED) {
      // Drop the oldest message that is not critical; if everything is critical, drop the oldest.
      const victim = this.queue.findIndex(item => !CRITICAL.has(messageType(item)));
      this.queue.splice(victim >= 0 ? victim : 0, 1);
    }
    this.queue.push(data);
  }

  ping(): void { if (this.raw && this.raw.readyState === OPEN) this.raw.ping(); }

  /** Constant-time check of a presented resume token. */
  matches(candidate: unknown): boolean {
    return typeof candidate === "string" && this.token !== undefined && candidate.length <= 200 && timingSafeEqual(digest(candidate), digest(this.token));
  }

  /** The browser socket dropped. Returns false when this channel cannot resume (the caller should end the call). */
  detach(graceMs: number, onExpire: () => void, now = Date.now()): boolean {
    if (!this.resumable || this.ended) return false;
    this.raw = null;
    this.since = now;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.detached) onExpire(); }, graceMs);
    this.timer.unref?.();
    return true;
  }

  /**
   * Bind a new socket to the call and rotate the token. The caller sends its `resumed` reply first, then
   * calls `flush()` to deliver everything queued while the browser was away.
   */
  attach(raw: SocketLike): { gapMs: number; flush: () => number } {
    const old = this.raw;
    const gapMs = this.since === undefined ? 0 : Date.now() - this.since;
    this.raw = raw;
    this.since = undefined;
    clearTimeout(this.timer);
    this.token = randomBytes(24).toString("hex");
    this.resumes++;
    // A half-open old socket may still look alive; the new one supersedes it.
    if (old && old !== raw && old.readyState === OPEN) { try { old.close(4001, "superseded"); } catch { /* already closing */ } }
    return {
      gapMs,
      flush: () => {
        let sent = 0;
        for (const item of this.queue.splice(0)) { try { raw.send(item); sent++; } catch { break; } }
        return sent;
      },
    };
  }

  /** Stop the grace timer without touching the socket (the call is ending anyway). */
  dispose(): void { clearTimeout(this.timer); this.queue = []; }

  close(code?: number, reason?: string): void {
    this.ended = true;
    this.dispose();
    const raw = this.raw;
    this.raw = null;
    try { raw?.close(code, reason); } catch { /* already closed */ }
  }

  terminate(): void {
    this.ended = true;
    this.dispose();
    const raw = this.raw;
    this.raw = null;
    try { raw?.terminate(); } catch { /* already closed */ }
  }
}

/** Keep only a small, typed set of client diagnostics; the browser is untrusted. */
export function cleanClientDiagnostics(value: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  for (const key of ["code", "attempts", "lastMessageMs", "callAgeSec", "rtt", "queuedBeforeMs"]) {
    if (typeof v[key] === "number" && Number.isFinite(v[key])) out[key] = Math.max(-1, Math.min(1e7, Math.round(v[key] as number)));
  }
  for (const key of ["wasClean", "online"]) if (typeof v[key] === "boolean") out[key] = v[key] as boolean;
  if (typeof v.downlink === "number" && Number.isFinite(v.downlink)) out.downlink = Math.max(0, Math.min(1e5, Math.round((v.downlink as number) * 10) / 10));
  for (const [key, max] of [["visibility", 10], ["net", 12], ["reason", 40]] as const) {
    if (typeof v[key] === "string") out[key] = (v[key] as string).replace(/[^\w .:/-]/g, "").slice(0, max);
  }
  return out;
}
