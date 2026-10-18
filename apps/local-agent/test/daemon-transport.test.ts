import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { CodexDaemonTransport, discoverCodexDaemon, probeCodexDaemon } from "../src/daemon-transport.js";

const threadId = "01a07bd4-fdda-7f92-9fdf-abc6564a04b6";
function fixture() {
  const home = "/fixture/.codex"; const uid = 1000; const pid = 1234;
  const alias = `${home}/app-server-control/app-server-control.sock`;
  const socket = `/tmp/codex-daemon-${uid}/${createHash("sha256").update(alias).digest("hex")}`;
  const texts = new Map<string, string>([
    [`${home}/app-server-daemon/app-server.pid`, JSON.stringify({ pid, processIdentity: { bootId: "boot", startTicks: 42 } })],
    ["/proc/sys/kernel/random/boot_id", "boot\n"],
    [`/proc/${pid}/stat`, `${pid} (codex worker (nested)) S ${Array(18).fill("0").join(" ")} 42 0`],
    [`/proc/${pid}/cmdline`, "/fixture/codex\0app-server\0--listen\0unix://\0--managed-daemon\0"],
    [`/proc/${pid}/net/unix`, `0000000000000000: 00000002 00000000 00010000 0001 01 300 ${socket}\n`],
    ["/proc/locks", `7: FLOCK ADVISORY WRITE ${pid} 08:01:200 0 EOF\n`],
  ]);
  const meta = (kind: "directory" | "file" | "socket", ino = 0n, mode = 0o700) =>
    ({ uid, mode, ino, dev: 2049n, directory: kind === "directory", file: kind === "file", socket: kind === "socket" });
  const metadata = new Map([
    [`${home}/app-server-daemon`, meta("directory")], [`${home}/app-server-control`, meta("directory")],
    [`${home}/app-server-daemon/app-server.pid`, meta("file", 1n, 0o644)], [`/proc/${pid}`, meta("directory")],
    [`/proc/${pid}/root/tmp/codex-daemon-${uid}`, meta("directory")], [`/proc/${pid}/root${socket}`, meta("socket", 300n, 0o600)],
    [`${home}/thread-writer-locks/${threadId}.lock`, meta("file", 200n, 0o600)],
  ]);
  const links = new Map([[`/proc/${pid}/exe`, "/fixture/codex"], [`/proc/${pid}/fd/9`, "socket:[300]"], [alias, socket]]);
  const real = new Map([[home, home], [alias, socket]]);
  const must = <T>(value: T | undefined): T => { if (value === undefined) throw new Error("fixture missing"); return value; };
  const io: Parameters<typeof probeCodexDaemon>[3] = {
    read: async path => must(texts.get(path)), link: async path => must(links.get(path)),
    real: async path => must(real.get(path)), entries: async () => ["9"], metadata: async path => must(metadata.get(path)),
  };
  return { home, uid, pid, socket, alias, io, texts, links, real, metadata };
}

test("daemon discovery binds exact thread lock, process generation, and secure listener", async () => {
  const f = fixture();
  assert.deepEqual(await probeCodexDaemon(threadId, f.home, f.uid, f.io), { pid: f.pid, startTicks: "42", socketPath: `/proc/${f.pid}/root${f.socket}`, threadId });
  assert.equal(await probeCodexDaemon("../../other", f.home, f.uid, f.io), null);
  assert.equal(await probeCodexDaemon(randomUUID(), f.home, f.uid, f.io), null);
});

test("daemon discovery refuses stale PID identity and foreign writer", async () => {
  for (const change of ["start", "boot", "writer", "process", "listener"] as const) {
    const f = fixture();
    if (change === "start") f.texts.set(`/proc/${f.pid}/stat`, `${f.pid} (codex) S ${Array(18).fill("0").join(" ")} 43 0`);
    if (change === "boot") f.texts.set("/proc/sys/kernel/random/boot_id", "other-boot");
    if (change === "writer") f.texts.set("/proc/locks", "7: FLOCK ADVISORY WRITE 9999 08:01:200 0 EOF\n");
    if (change === "process") f.links.set(`/proc/${f.pid}/exe`, "/fixture/grok");
    if (change === "listener") f.links.set(`/proc/${f.pid}/fd/9`, "socket:[301]");
    assert.equal(await probeCodexDaemon(threadId, f.home, f.uid, f.io), null, change);
  }
});

test("daemon discovery rejects a process replaced during inspection", async () => {
  const f = fixture(); const read = f.io.read;
  let identities = 0;
  f.io.read = async path => {
    const value = await read(path);
    return path === `/proc/${f.pid}/stat` && ++identities > 1 ? value.replace(" 42 0", " 43 0") : value;
  };
  assert.equal(await probeCodexDaemon(threadId, f.home, f.uid, f.io), null);
});

test("daemon discovery rejects arbitrary socket aliases and writable or foreign paths", async () => {
  for (const change of ["socket", "directory", "owner", "pidFile"] as const) {
    const f = fixture();
    if (change === "socket") f.links.set(f.alias, "/tmp/untrusted.sock");
    const path = change === "pidFile" ? `${f.home}/app-server-daemon/app-server.pid` : `/proc/${f.pid}/root/tmp/codex-daemon-${f.uid}`;
    const meta = f.metadata.get(path)!;
    if (change === "directory" || change === "pidFile") f.metadata.set(path, { ...meta, mode: 0o777 });
    if (change === "owner") f.metadata.set(path, { ...meta, uid: 9999 });
    assert.equal(await probeCodexDaemon(threadId, f.home, f.uid, f.io), null, change);
  }
});

test("transport cannot connect to an endpoint constructed by a caller", async () => {
  await assert.rejects(CodexDaemonTransport.connect({ pid: 123, startTicks: "1", socketPath: "/tmp/untrusted.sock", threadId }, {
    onMessage() {}, onClose() {},
  }), { code: "THREAD_WRITER_BUSY" });
});

// Isolated native fixture: no account credentials, no model calls and no live
// user threads. The first peer acts as the existing native client.
test("native daemon transport rejoins the same loaded thread and closes only its connection", {
  skip: !process.env.AGENTFLEET_NATIVE_TEST || process.platform !== "linux", timeout: 30_000,
}, async t => {
  const executable = process.env.AGENTFLEET_NATIVE_CODEX ?? "codex";
  const root = await mkdtemp(join(tmpdir(), "agentfleet-daemon-native-"));
  const home = join(root, "codex"); const cwd = join(root, "project"); const id = randomUUID();
  const day = join(home, "sessions", "2026", "09", "07");
  await mkdir(day, { recursive: true }); await mkdir(cwd);
  await mkdir(join(home, "app-server-daemon"), { mode: 0o700 });
  const timestamp = "2026-09-07T00:00:00.000Z";
  await writeFile(join(day, `rollout-2026-09-07T00-00-00-${id}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id, timestamp, cwd, originator: "codex_cli_rs", cli_version: "0.163.0", source: "cli", model_provider: "openai", base_instructions: { text: "Isolated fixture." } } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture only; never execute." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const environment = { HOME: root, CODEX_HOME: home, PATH: process.env.PATH };
  const daemon = spawn(executable, ["app-server", "--listen", "unix://", "--managed-daemon"], { env: environment, stdio: "ignore" });
  t.after(async () => {
    daemon.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => daemon.kill("SIGKILL"), 2_000);
      daemon.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await rm(root, { recursive: true, force: true });
  });
  assert.ok(daemon.pid);
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  let native: WebSocket | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const candidate = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 500 });
      await new Promise<void>((resolve, reject) => { candidate.once("open", resolve); candidate.once("error", reject); });
      native = candidate; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(native, "isolated daemon started");
  t.after(() => native?.terminate());
  let nextId = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const message = (line: string) => {
    const value = JSON.parse(line); const waiting = pending.get(value.id);
    if (!waiting) return;
    pending.delete(value.id);
    if (value.error) waiting.reject(new Error(JSON.stringify(value.error))); else waiting.resolve(value.result);
  };
  native.on("message", data => message(data.toString()));
  const rpc = (send: (value: string) => void, method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++nextId;
    pending.set(requestId, { resolve, reject }); send(JSON.stringify({ id: requestId, method, params }));
  });
  const nativeSend = (value: string) => native!.send(value);
  const init = { clientInfo: { name: "isolated-native-test", version: "0.1.0" }, capabilities: { experimentalApi: true } };
  await rpc(nativeSend, "initialize", init); nativeSend(JSON.stringify({ method: "initialized" }));
  await rpc(nativeSend, "thread/resume", { threadId: id, excludeTurns: true, cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
  const startTicks = (await readFile(`/proc/${daemon.pid}/stat`, "utf8")).split(") ")[1]!.split(" ")[19]!;
  await writeFile(join(home, "app-server-daemon", "app-server.pid"), JSON.stringify({ pid: daemon.pid,
    processIdentity: { bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), startTicks: Number(startTicks) } }));
  const endpoint = await discoverCodexDaemon(id, environment);
  assert.ok(endpoint, "precise daemon and native thread lock discovered");
  const transport = await CodexDaemonTransport.connect(endpoint, { onMessage: message, onClose() {} });
  t.after(() => transport.close());
  const sharedSend = (value: string) => { void transport.send(value); };
  await rpc(sharedSend, "initialize", init); await transport.send(JSON.stringify({ method: "initialized" }));
  const resumed = await rpc(sharedSend, "thread/resume", { threadId: id, excludeTurns: true, cwd, approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal(resumed.thread.id, id);
  assert.equal(resumed.approvalPolicy, "on-request", "shared resume cannot override another subscribed client's permission policy");
  assert.equal(transport.getProcessId(), daemon.pid);
  await rpc(sharedSend, "thread/unsubscribe", { threadId: id });
  await transport.close();
  assert.equal(daemon.exitCode, null, "closing our socket preserves native daemon");
  assert.equal((await rpc(nativeSend, "thread/read", { threadId: id, includeTurns: false })).thread.id, id, "original client remains usable");
});
