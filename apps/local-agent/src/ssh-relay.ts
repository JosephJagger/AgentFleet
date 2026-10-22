import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { AgentError } from "./errors.js";
import { RelayStream, type RelayFrame } from "./relay-stream.js";

/**
 * Carries SSH between two hosts that cannot reach each other, through the panel.
 *
 * Source side: `ssh` runs `agentfleet ssh-proxy` as its ProxyCommand, which talks to a unix socket owned by this agent.
 * Target side: the agent opens a connection to its own sshd on the loopback interface. The panel never names an
 * address or a port, so this can only ever reach the local SSH daemon; SSH itself stays end-to-end encrypted.
 */
const ALIAS = /^af-[a-z0-9][a-z0-9._-]{0,39}$/;
const ID = /^[A-Za-z0-9_-]{8,80}$/;
export const MAX_SOURCE_STREAMS = 8;
export const MAX_TARGET_STREAMS = 16;
export const RESUME_GRACE_MS = 90_000;
const OPEN_TIMEOUT_MS = 20_000;
const TARGET_CONNECT_TIMEOUT_MS = 5_000;
const HANDSHAKE_LINE_LIMIT = 512;
const SUN_PATH_LIMIT = 100;

interface Live { stream: RelayStream; role: "source" | "target"; suspendedAt?: number }
interface Pending { socket: net.Socket; timer: NodeJS.Timeout }

export interface SshRelayDeps {
  sshdPort: () => Promise<number>;
  /** Test hook: how the target side reaches its own sshd. */
  connect?: (port: number) => net.Socket;
  now?: () => number;
}

const defaultConnect = (port: number) => net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
const refuse = (socket: net.Socket, code: string, message: string) => { socket.end(`${JSON.stringify({ error: { code, message: message.slice(0, 200) } })}\n`); };

export class SshRelay {
  private send: ((frame: RelayFrame) => boolean) | undefined;
  private ready = false;
  private readonly streams = new Map<string, Live>();
  private readonly pending = new Map<string, Pending>();
  private routes = new Map<string, string>();
  private server: net.Server | undefined;
  private socketPath: string | undefined;
  private reaper: NodeJS.Timeout | undefined;
  private readonly told = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: SshRelayDeps) { this.now = deps.now ?? Date.now; }

  // ---- panel transport ----

  attach(send: (frame: RelayFrame) => boolean) { this.send = send; }

  /** The WebSocket died: keep every stream and let it resume, but stop accepting new connections. */
  transportLost() {
    this.ready = false;
    for (const live of this.streams.values()) { live.stream.transportLost(); live.suspendedAt ??= this.now(); }
    for (const [requestId, pending] of [...this.pending]) this.settle(requestId, pending, "panel_unavailable", "与面板的连接已中断，请稍后重试");
  }

  /** Reconnected and reconciled: resume every stream so the peer resends whatever was lost in flight. */
  transportReady() {
    this.ready = true;
    for (const live of this.streams.values()) { delete live.suspendedAt; live.stream.transportReady(); }
  }

  // ---- source side: the local socket that ssh-proxy talks to ----

  /** Called after every sync with the accounts that use the relay; an empty set stops listening. */
  async configure(socketPath: string | undefined, routes: Map<string, string>) {
    this.routes = routes;
    if (!socketPath || routes.size === 0) { await this.stop(); return; }
    if (this.server && this.socketPath === socketPath) return;
    await this.stop();
    if (Buffer.byteLength(socketPath) > SUN_PATH_LIMIT) throw new AgentError("SSH_RELAY_PATH_TOO_LONG", "本机路径过长，无法创建中转接入套接字");
    await fs.rm(socketPath, { force: true });
    const server = net.createServer({ allowHalfOpen: true }, socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
    await fs.chmod(socketPath, 0o600);
    this.server = server; this.socketPath = socketPath;
    this.reaper = setInterval(() => this.reap(), 5_000);
    this.reaper.unref();
  }

  async stop() {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    for (const [requestId, pending] of [...this.pending]) this.settle(requestId, pending, "route_removed", "中转路由已移除");
    for (const live of [...this.streams.values()]) if (live.role === "source") live.stream.abort("route_removed");
    const server = this.server; const path = this.socketPath;
    this.server = undefined; this.socketPath = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (path) await fs.rm(path, { force: true });
  }

  private accept(socket: net.Socket) {
    socket.setTimeout(10_000, () => refuse(socket, "handshake_timeout", "握手超时"));
    let line = "";
    const onData = (chunk: Buffer) => {
      line += chunk.toString("utf8");
      if (line.length > HANDSHAKE_LINE_LIMIT) { socket.off("data", onData); refuse(socket, "bad_request", "请求过大"); return; }
      const end = line.indexOf("\n");
      if (end < 0) return;
      socket.off("data", onData); socket.pause(); socket.setTimeout(0);
      this.begin(socket, line.slice(0, end));
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  }

  private begin(socket: net.Socket, line: string) {
    let alias: unknown;
    try { alias = (JSON.parse(line) as { alias?: unknown }).alias; } catch { return refuse(socket, "bad_request", "请求无效"); }
    const accountId = typeof alias === "string" && ALIAS.test(alias) ? this.routes.get(alias) : undefined;
    if (!accountId) return refuse(socket, "unknown_alias", "该主机没有使用面板中转的账号");
    if (!this.ready || !this.send) return refuse(socket, "panel_unavailable", "本机尚未连接到面板，请稍后重试");
    const sources = [...this.streams.values()].filter(live => live.role === "source").length + this.pending.size;
    if (sources >= MAX_SOURCE_STREAMS) return refuse(socket, "busy", "本机的中转连接数已达上限");
    const requestId = randomUUID();
    const timer = setTimeout(() => { const pending = this.pending.get(requestId); if (pending) this.settle(requestId, pending, "open_timeout", "建立中转连接超时"); }, OPEN_TIMEOUT_MS);
    timer.unref();
    this.pending.set(requestId, { socket, timer });
    socket.once("close", () => { const pending = this.pending.get(requestId); if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); } });
    if (!this.send({ type: "relay.connect", requestId, accountId })) this.settle(requestId, this.pending.get(requestId)!, "panel_unavailable", "无法向面板发送请求");
  }

  private settle(requestId: string, pending: Pending, code: string, message: string) {
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    refuse(pending.socket, code, message);
  }

  // ---- frames from the panel ----

  handleFrame(frame: RelayFrame) {
    switch (frame.type) {
      case "relay.opened": return this.onOpened(frame);
      case "relay.error": return this.onError(frame);
      case "relay.open": return void this.onOpen(frame);
      case "relay.data": case "relay.ack": case "relay.resume": case "relay.close": return this.onStreamFrame(frame);
      default: return undefined;
    }
  }

  private onOpened(frame: RelayFrame) {
    const { requestId, streamId } = frame;
    if (typeof requestId !== "string" || typeof streamId !== "string" || !ID.test(streamId)) return;
    const pending = this.pending.get(requestId);
    if (!pending) { this.send?.({ type: "relay.close", streamId, reason: "no_request" }); return; }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const { socket } = pending;
    socket.write(`${JSON.stringify({ ok: true })}\n`);
    this.adopt(streamId, "source", socket);
    socket.resume();
  }

  private onError(frame: RelayFrame) {
    const { requestId } = frame;
    const pending = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (!pending) return;
    const code = typeof frame.code === "string" && /^[a-z_]{1,40}$/.test(frame.code) ? frame.code : "relay_failed";
    this.settle(requestId as string, pending, code, typeof frame.message === "string" ? frame.message : "中转连接失败");
  }

  // ---- target side: reach the local sshd ----

  private async onOpen(frame: RelayFrame) {
    const { streamId } = frame;
    if (typeof streamId !== "string" || !ID.test(streamId) || this.streams.has(streamId)) return;
    const fail = (code: string, message: string) => { this.send?.({ type: "relay.error", streamId, code, message }); };
    if ([...this.streams.values()].filter(live => live.role === "target").length >= MAX_TARGET_STREAMS) return fail("busy", "目标主机的中转连接数已达上限");
    let port: number;
    try { port = await this.deps.sshdPort(); } catch { return fail("target_not_listening", "无法读取目标主机的 sshd 端口"); }
    const socket = (this.deps.connect ?? defaultConnect)(port);
    const timer = setTimeout(() => { socket.destroy(); fail("target_not_listening", "目标主机的 sshd 没有响应"); }, TARGET_CONNECT_TIMEOUT_MS);
    timer.unref();
    socket.once("error", () => { clearTimeout(timer); fail("target_not_listening", "目标主机的 sshd 没有在监听"); });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      this.adopt(streamId, "target", socket);
      this.send?.({ type: "relay.opened", streamId });
    });
  }

  private adopt(streamId: string, role: "source" | "target", local: net.Socket) {
    const live: Live = {
      role,
      stream: new RelayStream({ id: streamId, local, send: frame => this.send?.(frame) ?? false, onClosed: () => { this.streams.delete(streamId); } }),
    };
    if (!this.ready) { live.stream.transportLost(); live.suspendedAt = this.now(); }
    this.streams.set(streamId, live);
  }

  private onStreamFrame(frame: RelayFrame) {
    const id = frame.streamId;
    if (typeof id !== "string" || !ID.test(id)) return;
    const live = this.streams.get(id);
    if (live) { live.stream.handleFrame(frame); return; }
    // Tell the other end once that this side no longer has the stream, so it stops resending into the void.
    if (frame.type !== "relay.close" && !this.told.has(id) && this.told.size < 256) { this.told.add(id); this.send?.({ type: "relay.close", streamId: id, reason: "unknown_stream" }); }
  }

  /** A stream whose transport stayed down longer than the panel waits for it can never be resumed. */
  private reap() {
    const limit = this.now() - (RESUME_GRACE_MS + 30_000);
    for (const live of this.streams.values()) if (live.suspendedAt !== undefined && live.suspendedAt < limit) live.stream.abort("resume_timeout");
  }

  closeAll(reason: string) {
    for (const live of [...this.streams.values()]) live.stream.abort(reason);
  }

  get counts() {
    const live = [...this.streams.values()];
    return { source: live.filter(item => item.role === "source").length, target: live.filter(item => item.role === "target").length, pending: this.pending.size };
  }
}
