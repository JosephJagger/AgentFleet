import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { MAX_SOURCE_STREAMS, RESUME_GRACE_MS, SshRelay } from "../src/ssh-relay.js";
import { runSshProxy } from "../src/ssh-proxy.js";
import type { RelayFrame } from "../src/relay-stream.js";

/** What the panel does for relays, in miniature: allocate stream ids, pair the two ends, forward frames, and lose them when down. */
class FakeHub {
  up = true;
  /** A few milliseconds of network, so there really is something in flight when the link is cut. */
  latencyMs = 4;
  private generation = 0;
  private streams = new Map<string, { requestId: string }>();
  constructor(readonly source: SshRelay, readonly target: SshRelay) {
    source.attach(frame => this.from("source", frame));
    target.attach(frame => this.from("target", frame));
    source.transportReady(); target.transportReady();
  }
  private deliver(side: "source" | "target", frame: RelayFrame) {
    const generation = this.generation;
    setTimeout(() => { if (generation === this.generation && this.up) (side === "source" ? this.source : this.target).handleFrame(JSON.parse(JSON.stringify(frame))); }, this.latencyMs);
  }
  private from(side: "source" | "target", frame: RelayFrame): boolean {
    if (!this.up) return false;
    const copy = JSON.parse(JSON.stringify(frame)) as RelayFrame;
    if (side === "source" && copy.type === "relay.connect") {
      const streamId = `stream-${randomUUID()}`;
      this.streams.set(streamId, { requestId: String(copy.requestId) });
      this.deliver("target", { type: "relay.open", streamId });
    } else if (side === "target" && copy.type === "relay.opened") {
      this.deliver("source", { type: "relay.opened", requestId: this.streams.get(String(copy.streamId))?.requestId, streamId: copy.streamId });
    } else if (side === "target" && copy.type === "relay.error") {
      this.deliver("source", { type: "relay.error", requestId: this.streams.get(String(copy.streamId))?.requestId, code: copy.code, message: copy.message });
    } else if (String(copy.type).startsWith("relay.") && this.streams.has(String(copy.streamId))) {
      this.deliver(side === "source" ? "target" : "source", copy);
    }
    return true;
  }
  down() { this.up = false; this.generation++; this.source.transportLost(); this.target.transportLost(); }
  recover() { this.up = true; this.source.transportReady(); this.target.transportReady(); }
}

/** A stand-in for sshd: echoes every byte back upper-cased so both directions are checked at once. */
async function fakeSshd() {
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on("data", chunk => socket.write(Buffer.from(chunk.toString("latin1").toUpperCase(), "latin1")));
    socket.on("end", () => socket.end());
    socket.on("error", () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function setup(options: { port?: number } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "afr-"));
  const socketPath = join(directory, "r.sock");
  const sshd = await fakeSshd();
  const target = new SshRelay({ sshdPort: async () => options.port ?? sshd.port });
  const source = new SshRelay({ sshdPort: async () => sshd.port });
  const hub = new FakeHub(source, target);
  await source.configure(socketPath, new Map([["af-db", "ssh_db"]]));
  const cleanup = async () => { await source.stop(); target.closeAll("test_done"); sshd.server.close(); await fs.rm(directory, { recursive: true, force: true }); };
  return { directory, socketPath, sshd, source, target, hub, cleanup };
}

const proxy = (socketPath: string, extra: Record<string, unknown> = {}) => {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const out: Buffer[] = []; const err: Buffer[] = [];
  stdout.on("data", chunk => out.push(chunk)); stderr.on("data", chunk => err.push(chunk));
  const exit = runSshProxy({ alias: "af-db", socket: socketPath, openTimeoutMs: 5_000, ...extra }, { stdin, stdout, stderr });
  return { stdin, exit, output: () => Buffer.concat(out), errors: () => Buffer.concat(err).toString() };
};
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise(resolve => setTimeout(resolve, 5)); } };

test("ssh-proxy reaches the target's sshd through the relay and bytes flow both ways", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const client = proxy(rig.socketPath);
  const payload = Buffer.from("A".repeat(200_000).replace(/A/g, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))), "latin1");
  client.stdin.write(payload); client.stdin.end();
  assert.equal(await client.exit, 0);
  assert.equal(client.output().toString("latin1"), payload.toString("latin1").toUpperCase(), "everything came back transformed by the far side");
  // The far end finishes a moment later, once the last acknowledgements have crossed; nothing may be left behind.
  await until(() => JSON.stringify(rig.source.counts) === JSON.stringify({ source: 0, target: 0, pending: 0 }) && JSON.stringify(rig.target.counts) === JSON.stringify({ source: 0, target: 0, pending: 0 }));
});

test("the access socket is private, and stopping removes it", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  assert.equal((await fs.stat(rig.socketPath)).mode & 0o777, 0o600);
  await rig.source.configure(undefined, new Map());
  await assert.rejects(fs.stat(rig.socketPath));
  await assert.rejects(new SshRelay({ sshdPort: async () => 22 }).configure(join(rig.directory, "x".repeat(120), "r.sock"), new Map([["af-db", "ssh_db"]])), /路径过长/);
});

test("a connection survives the panel link dropping and coming back during traffic", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const client = proxy(rig.socketPath);
  // An outage while a connection is still being set up fails that attempt by design; the promise is about established ones.
  await until(() => rig.source.counts.source === 1 && rig.target.counts.target === 1);
  const sent: Buffer[] = [];
  for (let round = 0; round < 5; round++) {
    const chunk = Buffer.from(randomBytes(30_000).toString("hex"), "latin1");
    sent.push(chunk); client.stdin.write(chunk);
    // Cut the link while the data is still on its way, so frames really are lost in flight (a longer wait would let them land).
    await new Promise(resolve => setTimeout(resolve, round % 3));
    rig.hub.down();
    await new Promise(resolve => setTimeout(resolve, 15));
    rig.hub.recover();
  }
  client.stdin.end();
  assert.equal(await client.exit, 0);
  assert.equal(sha(client.output()), sha(Buffer.from(Buffer.concat(sent).toString("latin1").toUpperCase(), "latin1")), "nothing lost or repeated across five drops");
});

test("failures reach ssh as a clear message and a failing exit status", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const unknown = proxy(rig.socketPath, { alias: "af-other" });
  assert.equal(await unknown.exit, 255);
  assert.match(unknown.errors(), /没有使用面板中转的账号.*unknown_alias/);

  const missing = proxy(join(rig.directory, "nope.sock"));
  assert.equal(await missing.exit, 255);
  assert.match(missing.errors(), /面板中转不可用/);

  rig.hub.down();
  const offline = proxy(rig.socketPath);
  assert.equal(await offline.exit, 255);
  assert.match(offline.errors(), /panel_unavailable/);
  rig.hub.recover();

  const closed = net.createServer(); await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = (closed.address() as net.AddressInfo).port; await new Promise<void>(resolve => closed.close(() => resolve()));
  const rig2 = await setup({ port: deadPort }); t.after(rig2.cleanup);
  const noSshd = proxy(rig2.socketPath);
  assert.equal(await noSshd.exit, 255);
  assert.match(noSshd.errors(), /target_not_listening/);
});

test("an error message from a far host cannot put escape sequences on the user's terminal", async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), "afr-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "r.sock");
  const server = net.createServer(socket => { socket.on("data", () => socket.end(`${JSON.stringify({ error: { code: "target_failed", message: "\u001b[2J\u001b]0;pwned\u0007boom\r\nsecond line" } })}\n`)); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); t.after(() => { server.close(); });
  const client = proxy(socketPath);
  assert.equal(await client.exit, 255);
  assert.doesNotMatch(client.errors(), /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.match(client.errors(), /boom/);
});

test("auto goes direct when the address answers and falls back to the relay when it does not", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const pathDir = join(rig.directory, "last");
  const note = async () => JSON.parse(await fs.readFile(join(pathDir, "af-db"), "utf8")) as { path: string };

  const direct = proxy(rig.socketPath, { directHost: "127.0.0.1", directPort: rig.sshd.port, pathDir });
  direct.stdin.write("direct"); direct.stdin.end();
  assert.equal(await direct.exit, 0);
  assert.equal(direct.output().toString(), "DIRECT");
  assert.equal((await note()).path, "direct");

  const closed = net.createServer(); await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = (closed.address() as net.AddressInfo).port; await new Promise<void>(resolve => closed.close(() => resolve()));
  const viaRelay = proxy(rig.socketPath, { directHost: "127.0.0.1", directPort: deadPort, pathDir, directTimeoutMs: 500 });
  viaRelay.stdin.write("relayed"); viaRelay.stdin.end();
  assert.equal(await viaRelay.exit, 0);
  assert.equal(viaRelay.output().toString(), "RELAYED");
  assert.equal((await note()).path, "relay");
  assert.equal((await fs.stat(join(pathDir, "af-db"))).mode & 0o777, 0o600);
});

test("a source host will not open more relay connections than its limit", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const open = Array.from({ length: MAX_SOURCE_STREAMS }, () => proxy(rig.socketPath));
  await until(() => rig.source.counts.source === MAX_SOURCE_STREAMS);
  const extra = proxy(rig.socketPath);
  assert.equal(await extra.exit, 255);
  assert.match(extra.errors(), /busy/);
  for (const client of open) { client.stdin.end(); assert.equal(await client.exit, 0); }
});

test("a stream whose transport stays down past the grace period is dropped", async t => {
  let clock = 1_000_000;
  const directory = await fs.mkdtemp(join(tmpdir(), "afr-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sshd = await fakeSshd(); t.after(() => { sshd.server.close(); });
  const source = new SshRelay({ sshdPort: async () => sshd.port, now: () => clock });
  const target = new SshRelay({ sshdPort: async () => sshd.port, now: () => clock });
  const hub = new FakeHub(source, target);
  const socketPath = join(directory, "r.sock");
  await source.configure(socketPath, new Map([["af-db", "ssh_db"]]));
  t.after(async () => { await source.stop(); source.closeAll("test_done"); target.closeAll("test_done"); });
  const client = proxy(socketPath);
  await until(() => source.counts.source === 1 && target.counts.target === 1);
  hub.down();
  clock += RESUME_GRACE_MS + 31_000;
  (source as unknown as { reap(): void }).reap();
  assert.equal(source.counts.source, 0, "the suspended stream was abandoned");
  client.stdin.end();
  await client.exit;
});

test("only well-formed frames are acted on; nothing the panel sends can name an address", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  const seen: RelayFrame[] = [];
  rig.target.attach(frame => { seen.push(frame); return true; });
  rig.target.handleFrame({ type: "relay.open", streamId: "bad id!" });
  rig.target.handleFrame({ type: "relay.open", streamId: 42 });
  rig.target.handleFrame({ type: "relay.open", streamId: "valid-stream-1", host: "10.0.0.9", port: 22 });
  await until(() => seen.some(frame => frame.type === "relay.opened"));
  assert.equal(rig.target.counts.target, 1, "only the well-formed open was acted on");
  const outbound = JSON.stringify(seen);
  assert.ok(!outbound.includes("10.0.0.9"), "the target connected to its own sshd, whatever the frame said");
  rig.target.handleFrame({ type: "relay.data", streamId: "never-opened-1", seq: 1, ack: 0 });
  rig.target.handleFrame({ type: "relay.data", streamId: "never-opened-1", seq: 2, ack: 0 });
  assert.equal(seen.filter(frame => frame.type === "relay.close" && frame.reason === "unknown_stream").length, 1, "an unknown stream is reported once, not echoed forever");
});

const cliEntry = fileURLToPath(new URL("../src/ssh-proxy-cli.js", import.meta.url));
const runCli = (args: string[], input = "", ms = 10_000) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
  const child = spawn(process.execPath, [cliEntry, ...args]);
  let out = "", err = "";
  child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  child.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
  child.stdin.end(input);
});

test("the dedicated proxy entry point works as a real process, with or without the subcommand word", async t => {
  const rig = await setup(); t.after(rig.cleanup);
  for (const lead of [["ssh-proxy"], []]) {
    const result = await runCli([...lead, "--alias", "af-db", "--socket", rig.socketPath], "hello through a real process");
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "HELLO THROUGH A REAL PROCESS");
  }
  const direct = await runCli(["--alias", "af-db", "--socket", rig.socketPath, "--direct-host", "127.0.0.1", "--direct-port", String(rig.sshd.port), "--path-dir", join(rig.directory, "p")], "direct");
  assert.equal(direct.out, "DIRECT");
  assert.equal(JSON.parse(await fs.readFile(join(rig.directory, "p", "af-db"), "utf8")).path, "direct");
});

test("the dedicated entry point refuses anything it does not understand, and ssh sees a failing status", async () => {
  for (const args of [[], ["--alias", "af-db"], ["--socket", "/x"], ["--alias", "af-db", "--socket", "/x", "--exec", "id"], ["--alias", "--socket", "/x"], ["alias", "af-db", "socket", "/x"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 255, JSON.stringify(args));
    assert.match(result.err, /--alias and --socket are required/);
  }
  const unreachable = await runCli(["--alias", "af-db", "--socket", join(tmpdir(), "afr-does-not-exist.sock")]);
  assert.equal(unreachable.code, 255);
  assert.match(unreachable.err, /面板中转不可用/);
  assert.equal(unreachable.out, "", "nothing but the connection may ever be written to stdout");
});
