import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";
import { SessionAppServer } from "../src/session-app-server.js";
import { threadPermissionParams } from "../src/permissions.js";
import { resolveProject } from "../src/projects.js";

test("native session fallback rejoins the exact daemon writer, preserves permissions and never stops other clients", {
  skip: !process.env.AGENTFLEET_NATIVE_TEST || process.platform !== "linux", timeout: 60_000,
}, async t => {
  const executable = process.env.AGENTFLEET_NATIVE_CODEX ?? "codex";
  const root = await mkdtemp(join(tmpdir(), "agentfleet-session-daemon-native-"));
  const home = join(root, "codex"); const cwd = join(root, "project"); const id = randomUUID();
  const day = join(home, "sessions", "2026", "09", "07");
  await mkdir(day, { recursive: true }); await mkdir(cwd);
  await mkdir(join(home, "app-server-daemon"), { mode: 0o700 });
  const timestamp = "2026-09-07T00:00:00.000Z";
  await writeFile(join(day, `rollout-2026-09-07T00-00-00-${id}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id, timestamp, cwd, history_mode: "legacy", originator: "codex_cli_rs", cli_version: "0.163.0", source: "cli", model_provider: "openai", base_instructions: { text: "Isolated fixture." } } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture only; never execute." }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const environment: NodeJS.ProcessEnv = { HOME: root, CODEX_HOME: home, PATH: process.env.PATH, AGENTFLEET_CODEX_EXECUTABLE: executable };
  const daemon = spawn(executable, ["app-server", "--listen", "unix://", "--managed-daemon"], { env: environment, stdio: "ignore" });
  let native: WebSocket | undefined;
  let panel: SessionAppServer | undefined;
  t.after(async () => {
    await panel?.stop();
    native?.terminate();
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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const candidate = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 500 });
      await new Promise<void>((resolve, reject) => { candidate.once("open", resolve); candidate.once("error", reject); });
      native = candidate; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(native, "isolated native daemon is ready");
  let nextId = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  native.on("message", data => {
    const value = JSON.parse(data.toString()); const waiting = pending.get(value.id);
    if (!waiting) return;
    pending.delete(value.id);
    if (value.error) waiting.reject(new Error(JSON.stringify(value.error))); else waiting.resolve(value.result);
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++nextId;
    pending.set(requestId, { resolve, reject }); native!.send(JSON.stringify({ id: requestId, method, params }));
  });
  await rpc("initialize", { clientInfo: { name: "isolated-existing-client", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  native.send(JSON.stringify({ method: "initialized" }));
  const original = await rpc("thread/resume", { threadId: id, excludeTurns: true, cwd, ...threadPermissionParams(cwd, "project") });
  const proc = await readFile(`/proc/${daemon.pid}/stat`, "utf8");
  const startTicks = proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19]!;
  await writeFile(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: daemon.pid,
    processIdentity: { bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), startTicks: Number(startTicks) } }));
  const project = await resolveProject(cwd, "isolated-native-daemon");
  const callbacks: AppServerCallbacks = { findManagedThread: () => undefined, findProject: () => project,
    onEvent: async () => undefined, onVolatile: () => undefined, onApproval: async () => undefined,
    onApprovalResolved: async () => undefined, onExit: async () => undefined };
  const launches: Array<{ daemonThreadId?: string }> = [];
  const refusals: string[] = [];
  panel = new SessionAppServer(callbacks, (cb, epoch, options) => {
    launches.push(options ?? {});
    const client = new CodexAppServer(cb, epoch, environment, options);
    const resume = client.resumeThread.bind(client);
    client.resumeThread = async (...args) => {
      try { return await resume(...args); }
      catch (error) { refusals.push((error as { code: string }).code); throw error; }
    };
    return client;
  });
  await panel.start();
  const resumed = await panel.resumeThread(id, project, undefined, "project");
  assert.deepEqual(refusals, ["THREAD_WRITER_BUSY"], "private writer was refused before fallback");
  assert.equal(launches.filter(item => item.daemonThreadId === id).length, 1, "exactly one shared fallback");
  assert.equal(resumed.nativeThreadId, id);
  assert.equal(resumed.policyVerified, true, resumed.policyFailure);
  assert.equal(resumed.rawSummary.approvalPolicy, "on-request");
  assert.deepEqual(resumed.rawSummary.sandbox, original.sandbox);
  await panel.unsubscribeThread(id);
  assert.equal(daemon.exitCode, null, "panel release did not stop the daemon");
  assert.equal((await rpc("thread/read", { threadId: id, includeTurns: false })).thread.id, id, "original native connection remains usable");
  // A loaded subscribed thread ignores conflicting resume settings. The panel
  // must expose the failed permission verification instead of assuming a grant.
  const mismatch = await panel.resumeThread(id, project, undefined, "full");
  assert.equal(mismatch.nativeThreadId, id);
  assert.equal(mismatch.policyVerified, false, "ignored overrides cannot escalate native policy");
  assert.equal(mismatch.rawSummary.approvalPolicy, "on-request");
  await panel.unsubscribeThread(id);
  await panel.stop();
  assert.equal(daemon.exitCode, null, "stopping the entire facade also preserves shared daemon");
  assert.equal((await rpc("thread/read", { threadId: id, includeTurns: false })).thread.id, id);
  t.diagnostic("Native daemon takeover required no turn/start, credentials, model requests or changes to a real user thread.");
});
