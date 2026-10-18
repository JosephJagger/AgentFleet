import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import WebSocket from "ws";
import { AgentError } from "./errors.js";

export interface CodexDaemonEndpoint {
  readonly pid: number;
  readonly startTicks: string;
  readonly socketPath: string;
  readonly threadId: string;
}

type ProbeFiles = {
  read(path: string): Promise<string>;
  link(path: string): Promise<string>;
  real(path: string): Promise<string>;
  entries(path: string): Promise<string[]>;
  metadata(path: string, follow?: boolean): Promise<{ uid: number; mode: number; ino: bigint; dev: bigint; directory: boolean; file: boolean; socket: boolean }>;
};
const files: ProbeFiles = {
  read: async path => readFile(path, "utf8"), link: readlink, real: realpath, entries: readdir,
  metadata: async (path, follow = true) => {
    const value = await (follow ? stat : lstat)(path, { bigint: true });
    return { uid: Number(value.uid), mode: Number(value.mode), ino: value.ino, dev: value.dev,
      directory: value.isDirectory(), file: value.isFile(), socket: value.isSocket() };
  },
};
const origins = new WeakMap<CodexDaemonEndpoint, NodeJS.ProcessEnv>();

function processStartTicks(value: string): string | undefined {
  // /proc/PID/stat's comm may contain spaces and parentheses. Field 22 follows
  // the final closing parenthesis and state (field 3).
  return value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
}
function deviceNumbers(dev: bigint): [bigint, bigint] {
  return [((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn), (dev & 0xffn) | ((dev >> 12n) & ~0xffn)];
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Read-only Linux evidence probe. It never starts a daemon, follows an arbitrary
 * endpoint supplied by a caller, removes locks, or changes native settings.
 * The file abstraction is exported only to permit synthetic filesystem tests.
 */
export async function probeCodexDaemon(threadId: string, home: string, uid: number, io: ProbeFiles): Promise<CodexDaemonEndpoint | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId) || !isAbsolute(home)) return null;
  try {
    const codexHome = await io.real(home);
    const daemonDir = join(codexHome, "app-server-daemon");
    const controlDir = join(codexHome, "app-server-control");
    const pidPath = join(daemonDir, "app-server.pid");
    for (const path of [daemonDir, controlDir]) {
      const info = await io.metadata(path, false);
      if (!info.directory || info.uid !== uid || (info.mode & 0o077) !== 0) return null;
    }
    const pidInfo = await io.metadata(pidPath, false);
    if (!pidInfo.file || pidInfo.uid !== uid || (pidInfo.mode & 0o022) !== 0) return null;
    const raw = await io.read(pidPath);
    if (raw.length > 16_384) return null;
    const pidRecord: unknown = JSON.parse(raw);
    if (!record(pidRecord) || !Number.isSafeInteger(pidRecord.pid) || Number(pidRecord.pid) <= 1 || !record(pidRecord.processIdentity)) return null;
    const pid = Number(pidRecord.pid);
    const identity = pidRecord.processIdentity;
    const bootId = (await io.read("/proc/sys/kernel/random/boot_id")).trim();
    const startTicks = processStartTicks(await io.read(`/proc/${pid}/stat`));
    if (!startTicks || identity.bootId !== bootId || String(identity.startTicks) !== startTicks) return null;
    const processInfo = await io.metadata(`/proc/${pid}`);
    if (processInfo.uid !== uid) return null;
    const executable = await io.link(`/proc/${pid}/exe`);
    const args = (await io.read(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean);
    if (basename(executable) !== "codex" || !args.includes("app-server") || !args.includes("--managed-daemon") ||
        !args.some(arg => arg === "unix://" || arg.startsWith("unix:///"))) return null;

    const alias = join(controlDir, "app-server-control.sock");
    const physicalDir = `/tmp/codex-daemon-${uid}`;
    const physicalSocket = join(physicalDir, createHash("sha256").update(alias).digest("hex"));
    if (await io.link(alias) !== physicalSocket) return null;
    // The connector uses systemd PrivateTmp. Resolve the official daemon's
    // protected physical path in its mount namespace, not our private /tmp.
    // Its PID/start identity is checked again before opening this pathname.
    const socketPath = `/proc/${pid}/root${physicalSocket}`;
    const socketDirInfo = await io.metadata(`/proc/${pid}/root${physicalDir}`, false);
    const socketInfo = await io.metadata(socketPath, false);
    if (!socketDirInfo.directory || socketDirInfo.uid !== uid || (socketDirInfo.mode & 0o077) !== 0 ||
        !socketInfo.socket || socketInfo.uid !== uid || (socketInfo.mode & 0o077) !== 0) return null;
    // A secure pathname alone is insufficient: confirm this PID owns its listener.
    const sockets = (await io.read(`/proc/${pid}/net/unix`)).split("\n");
    const listener = sockets.map(line => line.trim().split(/\s+/)).find(columns => columns[7] === physicalSocket && columns[3] === "00010000");
    if (!listener?.[6] || !/^\d+$/.test(listener[6])) return null;
    const descriptors = await io.entries(`/proc/${pid}/fd`);
    let ownsListener = false;
    for (const descriptor of descriptors) {
      try { if (await io.link(`/proc/${pid}/fd/${descriptor}`) === `socket:[${listener[6]}]`) { ownsListener = true; break; } }
      catch { /* Concurrently closed unrelated descriptor. */ }
    }
    if (!ownsListener) return null;
    const lockPath = join(codexHome, "thread-writer-locks", `${threadId}.lock`);
    const lock = await io.metadata(lockPath, false);
    if (!lock.file || lock.uid !== uid) return null;
    const [major, minor] = deviceNumbers(lock.dev);
    const locks = await io.read("/proc/locks");
    const ownsWriter = locks.split("\n").some(line => {
      const columns = line.trim().split(/\s+/);
      if (columns[1] !== "FLOCK" || columns[2] !== "ADVISORY" || columns[3] !== "WRITE" || columns[4] !== String(pid)) return false;
      const identity = columns[5]?.split(":");
      return identity?.length === 3 && identity[0] && identity[1] && identity[2] &&
        BigInt(`0x${identity[0]}`) === major && BigInt(`0x${identity[1]}`) === minor && BigInt(identity[2]) === lock.ino;
    });
    if (!ownsWriter || processStartTicks(await io.read(`/proc/${pid}/stat`)) !== startTicks) return null;
    return Object.freeze({ pid, startTicks, socketPath, threadId });
  } catch { return null; }
}

export async function discoverCodexDaemon(threadId: string, environment: NodeJS.ProcessEnv = process.env): Promise<CodexDaemonEndpoint | null> {
  if (process.platform !== "linux" || !process.getuid) return null;
  const home = environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex");
  const endpoint = await probeCodexDaemon(threadId, home, process.getuid(), files);
  if (endpoint) origins.set(endpoint, { ...environment });
  return endpoint;
}

type TransportCallbacks = { onMessage(message: string): void; onClose(detail: string): void };

/** A connection to an already running native daemon. Closing this socket only
 * disconnects our client; it never signals, stops, or restarts the shared PID.
 */
export class CodexDaemonTransport {
  private closed = false;
  private constructor(private readonly endpoint: CodexDaemonEndpoint, private readonly socket: WebSocket) {}
  getProcessId() { return this.endpoint.pid; }

  static async connect(endpoint: CodexDaemonEndpoint, callbacks: TransportCallbacks): Promise<CodexDaemonTransport> {
    const environment = origins.get(endpoint);
    const current = environment && await discoverCodexDaemon(endpoint.threadId, environment);
    if (!current || current.pid !== endpoint.pid || current.startTicks !== endpoint.startTicks || current.socketPath !== endpoint.socketPath) {
      throw new AgentError("THREAD_WRITER_BUSY", "原生会话持有者已变化，无法安全连接");
    }
    const socket = new WebSocket(`ws+unix://${endpoint.socketPath}:/`, {
      handshakeTimeout: 5_000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false,
    });
    const transport = new CodexDaemonTransport(endpoint, socket);
    let connected = false;
    socket.on("message", (data, binary) => {
      if (binary) { socket.close(1003, "Expected text JSON-RPC"); return; }
      callbacks.onMessage(data.toString());
    });
    socket.on("error", () => undefined); // Connection errors are observed by open/close, never unhandled.
    socket.once("close", (code) => {
      transport.closed = true;
      if (connected) callbacks.onClose(`native daemon connection closed (${code})`);
    });
    await new Promise<void>((resolve, reject) => {
      const fail = () => { socket.off("open", open); reject(new AgentError("THREAD_WRITER_BUSY", "无法连接已核实的原生 Codex 后台")); };
      const open = () => { connected = true; socket.off("error", fail); socket.off("close", fail); resolve(); };
      socket.once("open", open); socket.once("error", fail); socket.once("close", fail);
    });
    return transport;
  }

  async send(message: string): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new AgentError("APP_SERVER_EXITED", "Native daemon connection is closed");
    await new Promise<void>((resolve, reject) => this.socket.send(message, error => error ? reject(error) : resolve()));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.socket.terminate(), 1_000);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }
}
