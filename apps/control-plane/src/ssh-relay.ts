import { randomUUID } from "node:crypto";
import type { ControlPlaneDatabase } from "./db.js";
import { nowIso } from "./crypto.js";
import type { SshAccessService } from "./ssh-access.js";

/**
 * Forwards SSH byte streams between two hosts of one workspace over their existing agent WebSockets.
 *
 * The panel never sees plaintext: the hosts run SSH end to end, and the panel only pairs the two ends, checks that the
 * pair is allowed, and passes frames along. It never names an address or port (the target host connects to its own
 * sshd), and it forwards only the fields it has validated. Delivery guarantees live in the hosts; here a dropped
 * WebSocket just suspends the stream for a grace period so the host can reconnect and resume it.
 */
export const RELAY_LIMITS = {
  perSource: 8,
  perTarget: 16,
  perWorkspace: 24,
  connectsPerMinute: 30,
  openTimeoutMs: 20_000,
  resumeGraceMs: 60_000,
  idleMs: 30 * 60_000,
  maxLifetimeMs: 8 * 60 * 60_000,
  maxDataChars: 90_000,
  // An abuse guard, not a speed limit: the hosts' own window and the network keep honest traffic far below this.
  bytesPerSecond: 32 * 1024 * 1024,
  housekeepingMs: 30_000,
} as const;

export interface RelayEndpoint { key: object; ready: boolean; supported: boolean; send: (value: Record<string, unknown>) => boolean }
export interface RelayDeps {
  db: ControlPlaneDatabase;
  sshAccess: SshAccessService;
  endpoint: (machineId: string) => RelayEndpoint | undefined;
  limiter: { check(key: string, maximum: number, windowMs: number): void };
  /** Throws while a deployment is waiting for the panel to go quiet, so new streams are not started into a restart. */
  admission: () => void;
  now?: () => number;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface Side { machineId: string; key: object | undefined; lostAt?: number }
interface Stream {
  id: string; workspaceId: string; accountId: string; alias: string; requestId: string;
  source: Side; target: Side;
  state: "opening" | "open" | "suspended";
  startedAt: number; lastActive: number; bytesUp: number; bytesDown: number;
  openTimer?: NodeJS.Timeout; graceTimer?: NodeJS.Timeout;
  window: { start: number; bytes: number };
}

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const ACCOUNT = /^[A-Za-z0-9_]{1,100}$/;
const REASON = /^[a-z_]{1,48}$/;
const CODE = /^[a-z_]{1,40}$/;
const safeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** Text from a host ends up in another host's terminal, so it is reduced to printable characters and a sane length. */
const printable = (value: string, max = 200) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, max);
const reasonOf = (value: unknown, fallback: string) => typeof value === "string" && REASON.test(value) ? value : fallback;

export class SshRelayHub {
  private readonly streams = new Map<string, Stream>();
  private readonly told = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: RelayDeps) {
    this.now = deps.now ?? Date.now;
    // A previous process may have died with streams open; nothing of them survives a restart.
    deps.db.run("UPDATE ssh_relay_streams SET state='closed',closed_at=?,close_reason='panel_restart' WHERE closed_at IS NULL", nowIso());
    deps.db.run("DELETE FROM ssh_relay_streams WHERE closed_at IS NOT NULL AND closed_at<?", new Date(this.now() - 30 * 86_400_000).toISOString());
    this.timer = setInterval(() => this.housekeeping(), RELAY_LIMITS.housekeepingMs);
    this.timer.unref();
  }

  get active() { return this.streams.size; }
  activeIn(workspaceId: string) { return [...this.streams.values()].filter(stream => stream.workspaceId === workspaceId).length; }

  // ---- frames from hosts ----

  receive(machineId: string, key: object, message: Record<string, unknown>) {
    switch (message.type) {
      case "relay.connect": return this.connect(machineId, key, message);
      case "relay.opened": return this.opened(machineId, key, message);
      case "relay.error": return this.refused(machineId, key, message);
      case "relay.data": case "relay.ack": case "relay.resume": case "relay.close": return this.forward(machineId, key, message);
      default: return undefined;
    }
  }

  private connect(machineId: string, key: object, message: Record<string, unknown>) {
    const requestId = typeof message.requestId === "string" && ID.test(message.requestId) ? message.requestId : undefined;
    const accountId = typeof message.accountId === "string" && ACCOUNT.test(message.accountId) ? message.accountId : undefined;
    if (!requestId || !accountId) return; // nothing to answer: there is no valid request id to answer to
    const source = this.deps.endpoint(machineId);
    const deny = (code: string, text: string, reason: string) => {
      source?.send({ type: "relay.error", requestId, code, message: text });
      this.audit(machineId, "ssh.relay.open", "denied", { accountId, reason });
    };
    if (!source || source.key !== key) return;
    try { this.deps.admission(); } catch { return deny("deployment_wait", "面板正在更新，请稍后重试", "deployment_wait"); }
    try { this.deps.limiter.check(`ssh-relay:${machineId}`, RELAY_LIMITS.connectsPerMinute, 60_000); } catch { return deny("rate_limited", "中转连接过于频繁，请稍后重试", "rate_limited"); }
    const verdict = this.deps.sshAccess.authoriseRelay(machineId, accountId, {
      routes: true, relay: source.supported,
      targetRelay: id => { const endpoint = this.deps.endpoint(id); return endpoint ? (endpoint.supported ? "yes" : "no") : "unknown"; },
    });
    if (!verdict.ok) return deny("not_allowed", "面板没有允许此主机经中转访问该账号", verdict.reason);
    const target = this.deps.endpoint(verdict.targetMachineId);
    if (!target || !target.ready) return deny("target_offline", "目标主机不在线", "target_offline");
    if (!target.supported) return deny("target_unsupported", "目标主机的连接服务需要更新才能使用中转", "target_unsupported");
    const live = [...this.streams.values()];
    if (live.filter(stream => stream.source.machineId === machineId).length >= RELAY_LIMITS.perSource) return deny("busy", "此主机的中转连接数已达上限", "per_source_limit");
    if (live.filter(stream => stream.target.machineId === verdict.targetMachineId).length >= RELAY_LIMITS.perTarget) return deny("busy", "目标主机的中转连接数已达上限", "per_target_limit");
    if (live.filter(stream => stream.workspaceId === verdict.workspaceId).length >= RELAY_LIMITS.perWorkspace) return deny("busy", "工作区的中转连接数已达上限", "per_workspace_limit");

    const stream: Stream = {
      id: `rs_${randomUUID()}`, workspaceId: verdict.workspaceId, accountId, alias: verdict.alias, requestId,
      source: { machineId, key }, target: { machineId: verdict.targetMachineId, key: target.key },
      state: "opening", startedAt: this.now(), lastActive: this.now(), bytesUp: 0, bytesDown: 0, window: { start: this.now(), bytes: 0 },
    };
    this.streams.set(stream.id, stream);
    const stamp = nowIso();
    this.deps.db.run(`INSERT INTO ssh_relay_streams(stream_id,workspace_id,account_id,source_machine_id,target_machine_id,state,started_at,last_active_at) VALUES(?,?,?,?,?,'opening',?,?)`,
      stream.id, stream.workspaceId, accountId, machineId, verdict.targetMachineId, stamp, stamp);
    stream.openTimer = setTimeout(() => this.fail(stream, "open_timeout", "目标主机没有及时响应"), RELAY_LIMITS.openTimeoutMs);
    stream.openTimer.unref();
    if (!target.send({ type: "relay.open", streamId: stream.id })) this.fail(stream, "target_offline", "目标主机的连接已断开");
  }

  /** The target reached its own sshd: tell the source, and from here the frames flow. */
  private opened(machineId: string, key: object, message: Record<string, unknown>) {
    const stream = this.lookup(message.streamId);
    // The target opened a connection for a stream that was cancelled meanwhile: it must not keep that connection.
    if (!stream && typeof message.streamId === "string" && ID.test(message.streamId)) return this.unknown(machineId, message.streamId);
    if (!stream || stream.state !== "opening" || stream.target.machineId !== machineId || stream.target.key !== key) return;
    if (stream.openTimer) clearTimeout(stream.openTimer);
    delete stream.openTimer;
    stream.state = "open";
    this.touch(stream, "open");
    if (!this.send(stream.source, { type: "relay.opened", requestId: stream.requestId, streamId: stream.id })) return this.close(stream, "source_offline");
    this.audit(stream.source.machineId, "ssh.relay.open", "success", { accountId: stream.accountId, streamId: stream.id, targetMachineId: stream.target.machineId });
  }

  private refused(machineId: string, key: object, message: Record<string, unknown>) {
    const stream = this.lookup(message.streamId);
    if (!stream || stream.state !== "opening" || stream.target.machineId !== machineId || stream.target.key !== key) return;
    const code = typeof message.code === "string" && CODE.test(message.code) ? message.code : "target_failed";
    this.fail(stream, code, typeof message.message === "string" ? printable(message.message) : "目标主机拒绝了连接");
  }

  private forward(machineId: string, key: object, message: Record<string, unknown>) {
    const id = typeof message.streamId === "string" && ID.test(message.streamId) ? message.streamId : undefined;
    if (!id) return;
    const stream = this.streams.get(id);
    if (!stream) { if (message.type !== "relay.close") this.unknown(machineId, id); return; }
    const side = stream.source.machineId === machineId ? "source" : stream.target.machineId === machineId ? "target" : undefined;
    if (!side || stream.state === "opening") return;
    const own = side === "source" ? stream.source : stream.target;
    const peer = side === "source" ? stream.target : stream.source;

    if (message.type === "relay.close") {
      const reason = reasonOf(message.reason, "closed");
      this.relay(peer, { type: "relay.close", streamId: id, reason });
      return this.close(stream, reason === "complete" ? "complete" : `${side}_closed`, false);
    }
    if (message.type === "relay.resume") {
      if (!safeInt(message.recvSeq) || this.deps.endpoint(machineId)?.key !== key) return;
      // The host is back on a new socket: rebind it, and let the peer know where it stands so it can resend what was lost.
      own.key = key; delete own.lostAt;
      if (stream.state === "suspended" && stream.source.key && stream.target.key) { stream.state = "open"; if (stream.graceTimer) clearTimeout(stream.graceTimer); delete stream.graceTimer; this.touch(stream, "open"); }
      this.relay(peer, { type: "relay.resume", streamId: id, recvSeq: message.recvSeq, ...(message.reply === true ? { reply: true } : {}) });
      return;
    }
    if (own.key !== key) return; // a stale socket that has since been superseded
    if (message.type === "relay.ack") {
      if (!safeInt(message.ack)) return;
      this.relay(peer, { type: "relay.ack", streamId: id, ack: message.ack });
      return;
    }
    // relay.data
    const data = message.data;
    if (!safeInt(message.seq) || message.seq < 1 || !safeInt(message.ack) || (data !== undefined && (typeof data !== "string" || data.length > RELAY_LIMITS.maxDataChars))
      || (message.fin !== undefined && typeof message.fin !== "boolean")) return this.close(stream, "protocol", true);
    const bytes = typeof data === "string" ? Math.floor(data.length * 3 / 4) : 0;
    if (!this.within(stream, bytes)) return this.close(stream, "rate_limited", true);
    stream.lastActive = this.now();
    if (side === "source") stream.bytesUp += bytes; else stream.bytesDown += bytes;
    this.relay(peer, { type: "relay.data", streamId: id, seq: message.seq, ack: message.ack, ...(typeof data === "string" ? { data } : {}), ...(message.fin === true ? { fin: true } : {}) });
  }

  /** Tell a host once that a stream is gone, so it stops resending into the void. */
  private unknown(machineId: string, streamId: string) {
    if (this.told.has(`${machineId}|${streamId}`) || this.told.size >= 1024) return;
    this.told.add(`${machineId}|${streamId}`);
    this.deps.endpoint(machineId)?.send({ type: "relay.close", streamId, reason: "unknown_stream" });
  }

  // ---- connection lifecycle ----

  /** A host's WebSocket went away. Its streams are suspended, not closed: the host usually reconnects within seconds. */
  disconnect(machineId: string, key: object) {
    for (const stream of [...this.streams.values()]) {
      const side = stream.source.machineId === machineId && stream.source.key === key ? stream.source : stream.target.machineId === machineId && stream.target.key === key ? stream.target : undefined;
      if (!side) continue;
      side.key = undefined; side.lostAt = this.now();
      if (stream.state === "opening") { this.fail(stream, side === stream.target ? "target_offline" : "source_offline", "连接已断开"); continue; }
      stream.state = "suspended";
      this.touch(stream, "suspended");
      stream.graceTimer ??= setTimeout(() => this.close(stream, "resume_timeout", true), RELAY_LIMITS.resumeGraceMs);
      stream.graceTimer.unref();
    }
  }

  /** Authorisation changed (account removed or disabled, relay switched off, host revoked): close what is no longer allowed. */
  reevaluate(workspaceId: string, reason: string) {
    for (const stream of [...this.streams.values()]) {
      if (stream.workspaceId !== workspaceId) continue;
      const verdict = this.deps.sshAccess.authoriseRelay(stream.source.machineId, stream.accountId, {
        routes: true, relay: true, targetRelay: () => "unknown",
      });
      if (!verdict.ok || verdict.targetMachineId !== stream.target.machineId) this.close(stream, reason, true);
    }
  }

  closeMachine(machineId: string, reason: string) {
    for (const stream of [...this.streams.values()]) if (stream.source.machineId === machineId || stream.target.machineId === machineId) this.close(stream, reason, true);
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // On the way down the database may already be closed; whatever stays marked open is closed as `panel_restart` at the next start.
    for (const stream of [...this.streams.values()]) { try { this.close(stream, "panel_shutdown", false); } catch { this.streams.delete(stream.id); } }
  }

  // ---- internals ----

  private lookup(value: unknown) { return typeof value === "string" && ID.test(value) ? this.streams.get(value) : undefined; }

  private send(side: Side, frame: Record<string, unknown>): boolean {
    if (!side.key) return false;
    const endpoint = this.deps.endpoint(side.machineId);
    return Boolean(endpoint && endpoint.key === side.key && endpoint.send(frame));
  }

  /** Forward to the peer if it is connected; otherwise it is suspended and will ask for what it missed when it resumes. */
  private relay(side: Side, frame: Record<string, unknown>) { this.send(side, frame); }

  private within(stream: Stream, bytes: number) {
    const now = this.now();
    if (now - stream.window.start >= 1000) stream.window = { start: now, bytes: 0 };
    stream.window.bytes += bytes;
    return stream.window.bytes <= RELAY_LIMITS.bytesPerSecond;
  }

  private touch(stream: Stream, state: Stream["state"]) {
    this.deps.db.run("UPDATE ssh_relay_streams SET state=?,last_active_at=?,bytes_up=?,bytes_down=? WHERE stream_id=?", state, nowIso(), stream.bytesUp, stream.bytesDown, stream.id);
  }

  /** The stream never became usable: answer the source's request with the reason. */
  private fail(stream: Stream, code: string, text: string) {
    this.send(stream.source, { type: "relay.error", requestId: stream.requestId, code, message: text });
    this.audit(stream.source.machineId, "ssh.relay.open", "denied", { accountId: stream.accountId, reason: code, streamId: stream.id });
    // The requester already has its answer; only the target may still be connecting and needs to be told to stop.
    this.close(stream, code, false, false);
    this.send(stream.target, { type: "relay.close", streamId: stream.id, reason: code });
  }

  private close(stream: Stream, reason: string, notify = true, record = true) {
    if (!this.streams.delete(stream.id)) return;
    if (stream.openTimer) clearTimeout(stream.openTimer);
    if (stream.graceTimer) clearTimeout(stream.graceTimer);
    if (notify) for (const side of [stream.source, stream.target]) this.send(side, { type: "relay.close", streamId: stream.id, reason });
    this.deps.db.run("UPDATE ssh_relay_streams SET state='closed',closed_at=?,close_reason=?,last_active_at=?,bytes_up=?,bytes_down=? WHERE stream_id=?",
      nowIso(), reason, nowIso(), stream.bytesUp, stream.bytesDown, stream.id);
    if (record) this.audit(stream.source.machineId, "ssh.relay.close", "success", {
      accountId: stream.accountId, streamId: stream.id, targetMachineId: stream.target.machineId, reason,
      durationMs: this.now() - stream.startedAt, bytesUp: stream.bytesUp, bytesDown: stream.bytesDown,
    });
    for (const key of [...this.told]) if (key.endsWith(`|${stream.id}`)) this.told.delete(key);
  }

  private housekeeping() {
    const now = this.now();
    for (const stream of [...this.streams.values()]) {
      if (now - stream.startedAt > RELAY_LIMITS.maxLifetimeMs) this.close(stream, "max_lifetime", true);
      else if (now - stream.lastActive > RELAY_LIMITS.idleMs) this.close(stream, "idle_timeout", true);
      else if (stream.state !== "opening") this.touch(stream, stream.state);
    }
  }

  private audit(machineId: string, action: string, outcome: string, metadata: Record<string, unknown>) {
    const workspaceId = this.deps.sshAccess.workspaceOf(machineId);
    if (!workspaceId) return;
    try { this.deps.db.audit({ workspaceId, machineId, action, outcome, metadata }); } catch (error) { this.deps.log?.({ error: String(error) }, "relay audit failed"); }
  }
}
