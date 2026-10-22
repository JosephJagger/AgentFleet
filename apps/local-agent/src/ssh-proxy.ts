import fs from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

/**
 * `ssh` runs this as its ProxyCommand. It must behave exactly like a plain TCP connection on stdin/stdout:
 * with a direct address it tries that first and only falls back to the local agent's relay socket when it fails.
 */
export interface SshProxyOptions {
  alias: string;
  socket: string;
  directHost?: string;
  directPort?: number;
  /** Where to leave a note of which path was used, so the panel's connection test can report it. */
  pathDir?: string;
  directTimeoutMs?: number;
  openTimeoutMs?: number;
}
/** What a failed relay says is shown on the user's terminal, so nothing but printable text may reach it. */
const printable = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, 300);
export interface SshProxyIo { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

function tryConnect(connect: () => net.Socket, timeoutMs: number): Promise<net.Socket | undefined> {
  return new Promise(resolve => {
    const socket = connect();
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.removeAllListeners("error"); resolve(socket); });
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolve(undefined); });
  });
}

async function remember(options: SshProxyOptions, path: "direct" | "relay") {
  if (!options.pathDir) return;
  try {
    await fs.mkdir(options.pathDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(options.pathDir, options.alias), JSON.stringify({ path, at: Date.now() }), { mode: 0o600 });
  } catch { /* purely informational */ }
}

/** Reads the single JSON line the agent answers with, leaving anything after it untouched. */
function readLine(socket: net.Socket, timeoutMs: number): Promise<{ line: string; rest: Buffer } | undefined> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0);
    const finish = (value?: { line: string; rest: Buffer }) => { clearTimeout(timer); socket.off("data", onData); socket.off("close", onClose); socket.pause(); resolve(value); };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end >= 0) finish({ line: buffer.subarray(0, end).toString("utf8"), rest: buffer.subarray(end + 1) });
      else if (buffer.length > 4096) finish(undefined);
    };
    const onClose = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on("data", onData); socket.on("close", onClose);
  });
}

function bridge(io: SshProxyIo, socket: net.Socket, first?: Buffer): Promise<number> {
  return new Promise(resolve => {
    let settled = false;
    const done = (code: number) => { if (!settled) { settled = true; resolve(code); } };
    if (first?.length) io.stdout.write(first);
    socket.resume();
    io.stdin.on("data", (chunk: Buffer | string) => { if (!socket.write(chunk)) { (io.stdin as NodeJS.ReadStream).pause?.(); socket.once("drain", () => (io.stdin as NodeJS.ReadStream).resume?.()); } });
    io.stdin.on("end", () => socket.end());
    socket.on("data", chunk => { if (!io.stdout.write(chunk)) { socket.pause(); io.stdout.once("drain", () => socket.resume()); } });
    socket.on("close", () => done(0));
    socket.on("error", () => done(255));
  });
}

export async function runSshProxy(options: SshProxyOptions, io: SshProxyIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  if (options.directHost && options.directPort) {
    const direct = await tryConnect(() => net.connect({ host: options.directHost!, port: options.directPort!, allowHalfOpen: true }), options.directTimeoutMs ?? 3_000);
    if (direct) { await remember(options, "direct"); return bridge(io, direct); }
  }
  const ipc = await tryConnect(() => net.connect({ path: options.socket, allowHalfOpen: true }), 3_000);
  if (!ipc) { io.stderr.write("agentfleet: 面板中转不可用：本机连接服务未运行，或没有启用中转的账号\n"); return 255; }
  ipc.write(`${JSON.stringify({ alias: options.alias })}\n`);
  const reply = await readLine(ipc, options.openTimeoutMs ?? 30_000);
  let parsed: { ok?: boolean; error?: { code?: string; message?: string } } = {};
  try { parsed = reply ? JSON.parse(reply.line) as typeof parsed : {}; } catch { /* handled below */ }
  if (!reply || parsed.ok !== true) {
    io.stderr.write(`agentfleet: 面板中转失败：${printable(parsed.error?.message ?? "没有收到响应")}${parsed.error?.code ? `（${printable(parsed.error.code)}）` : ""}\n`);
    ipc.destroy();
    return 255;
  }
  await remember(options, "relay");
  return bridge(io, ipc, reply.rest);
}
