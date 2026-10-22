import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { AuthService } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { sha256 } from "../src/crypto.js";
import { buildControlPlane } from "../src/server.js";

function keyPair() {
  const root = mkdtempSync(join(tmpdir(), "cp-relay-ws-")); const path = join(root, "key");
  try { execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path]); return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8").trim() }; }
  finally { rmSync(root, { recursive: true, force: true }); }
}

type Frame = Record<string, unknown>;

/** A host as the panel sees it: a real WebSocket that answers the panel's ssh requests the way an agent does. */
class FakeHost {
  readonly inbox: Frame[] = [];
  socket!: WebSocket;
  constructor(readonly machineId: string, private readonly hostKey: string) {}
  attach(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as Frame;
      if (message.type === "ssh.request") {
        const result = message.action === "inspect" ? { userExists: true, authorized: true, hostKeys: [this.hostKey], addresses: ["10.0.0.9"], port: 22, listening: true }
          : message.action === "sync" ? { accounts: Object.fromEntries(((message.accounts as Frame[]) ?? []).map(account => [account.id as string, { ok: true }])) } : { ok: true };
        this.inbox.push(message);
        socket.send(JSON.stringify({ type: "ssh.result", requestId: message.requestId, result }));
        return;
      }
      this.inbox.push(message);
    });
  }
  send(frame: Frame) { this.socket.send(JSON.stringify(frame)); }
  async next(predicate: (frame: Frame) => boolean, label: string, ms = 3000): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0]!;
      if (Date.now() > end) throw new Error(`${this.machineId}: timed out waiting for ${label}; inbox=${JSON.stringify(this.inbox.map(frame => frame.type))}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  nextType(type: string, ms?: number) { return this.next(frame => frame.type === type, type, ms); }
  has(predicate: (frame: Frame) => boolean) { return this.inbox.some(predicate); }
}

test("two hosts relay SSH bytes through the panel over real WebSockets, survive a reconnect, and lose the stream when revoked", async t => {
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "test-admin-password-long", PUBLIC_ORIGIN: "http://relay.test", COOKIE_SECURE: "false", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  await app.ready();
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => setImmediate(resolve)); await app.close(); });
  const auth = new AuthService(db, config);
  const admin = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "test");
  const headers = { cookie: `${config.cookieName}=${admin.sessionToken}`, origin: config.publicOrigin, "x-csrf-token": admin.csrfToken };
  const workspaceId = admin.principal.workspaceId;
  const stamp = new Date().toISOString();
  for (const id of ["a", "b", "c"]) db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at)
    VALUES(?,?,?,?,?,'linux','24.04','x64','0.30.145','active','normal','offline','compatible','idle',?,?)`, `host-${id}`, workspaceId, `spki-${id}`, `fp-${id}`, id, stamp, stamp);

  const generation = new Map<string, number>();
  const hostKey = keyPair().publicKey;
  async function connect(id: string, capabilities: Record<string, boolean>, host = new FakeHost(`host-${id}`, hostKey)) {
    const machineId = `host-${id}`;
    const token = `ticket-${randomUUID()}`; const gen = (generation.get(machineId) ?? 0) + 1; generation.set(machineId, gen);
    db.run("INSERT INTO agent_tickets(ticket_id,machine_id,token_hash,audience,transport_generation,created_at,expires_at) VALUES(?,?,?,'agent-ws',?,?,?)", `t-${randomUUID()}`, machineId, sha256(token), gen, stamp, new Date(Date.now() + 60_000).toISOString());
    const socket = await app.injectWS(`/ws/agent?ticket=${token}`, {}, { onInit: ws => host.attach(ws) });
    sockets.push(socket);
    await host.nextType("welcome");
    const streams = [{ producerEpoch: `producer-${id}`, throughHostSeq: 0 }];
    host.send({ type: "hello", producerEpoch: `producer-${id}`, appServerEpoch: `runtime-${id}`, agentVersion: "0.30.145", capabilities, codexVersion: "0.163.0",
      schemaHash: "d204b96d8560d56600127423b89df9db471b3e22338e8809bb91d5a952998978", credentialProtectionLevel: "software_protected", platform: "linux", platformRelease: "24.04",
      architecture: "x86_64", capacity: "idle", projects: [], sessions: [], reconciliationStreams: streams });
    const ack = await host.nextType("hello.ack");
    host.send({ type: "reconciliation.complete", reconciliationId: ack.reconciliationId, reconciliationStreams: streams });
    await host.nextType("reconciliation.ack");
    return host;
  }
  const full = { sshAccess: true, sshRoutes: true, sshRelay: true };
  const a = await connect("a", full), b = await connect("b", full);
  const relayStreams = () => db.all<{ state: string; close_reason: string | null; bytes_up: number; bytes_down: number }>("SELECT state,close_reason,bytes_up,bytes_down FROM ssh_relay_streams ORDER BY started_at");

  // The workspace admin switches the relay on and registers an account for b that is reached through the panel.
  const switched = await app.inject({ method: "PUT", url: "/api/ssh-relay", headers, payload: { enabled: true, revision: 0 } });
  assert.equal(switched.statusCode, 200, switched.body);
  const pair = keyPair();
  const created = await app.inject({ method: "POST", url: "/api/ssh-accounts", headers, payload: { machineId: "host-b", username: "deploy", privateKey: pair.privateKey, route: "relay" } });
  assert.equal(created.statusCode, 200, created.body);
  const account = created.json().account as { id: string; alias: string; route: string; hostKeyFingerprints: string[] };
  assert.equal(account.route, "relay");
  assert.equal(account.hostKeyFingerprints.length, 1, "the host key reported by the target was pinned");

  // a is given the account as a relay account; b, the target, is not given its own account.
  const sync = await a.next(frame => frame.type === "ssh.request" && frame.action === "sync" && (frame.accounts as Frame[]).some(item => item.id === account.id), "a's sync with the relay account");
  const given = (sync.accounts as Frame[]).find(item => item.id === account.id)!;
  assert.equal(given.route, "relay");
  assert.equal((given.hostKeys as string[]).length, 1);
  assert.equal(given.proxyJump, undefined);

  // a asks for a stream; only b is told, and only with a stream id.
  a.send({ type: "relay.connect", requestId: "request-12345", accountId: account.id });
  const open = await b.nextType("relay.open");
  assert.deepEqual(Object.keys(open).sort(), ["streamId", "type"]);
  const streamId = open.streamId as string;
  b.send({ type: "relay.opened", streamId });
  assert.deepEqual(await a.nextType("relay.opened"), { type: "relay.opened", requestId: "request-12345", streamId });
  assert.equal((await app.inject({ method: "GET", url: "/api/ssh-relay", headers })).json().active, 1);

  const payload = Buffer.from("SSH-2.0-OpenSSH_9.9\r\n").toString("base64");
  a.send({ type: "relay.data", streamId, seq: 1, ack: 0, data: payload });
  assert.equal((await b.nextType("relay.data")).data, payload);
  b.send({ type: "relay.data", streamId, seq: 1, ack: 1, data: payload });
  assert.equal((await a.nextType("relay.data")).data, payload);

  // A third host that cannot carry the relay is refused with a reason, and nothing is started for it.
  const c = await connect("c", { sshAccess: true, sshRoutes: true });
  c.send({ type: "relay.connect", requestId: "request-99999", accountId: account.id });
  assert.equal((await c.nextType("relay.error")).code, "not_allowed");
  assert.equal(b.has(frame => frame.type === "relay.open"), false);

  // a's WebSocket drops. The stream is suspended, not lost.
  a.socket.terminate();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(relayStreams()[0]?.state, "suspended");
  const a2 = await connect("a", full);
  a2.send({ type: "relay.resume", streamId, recvSeq: 1 });
  assert.deepEqual(await b.nextType("relay.resume"), { type: "relay.resume", streamId, recvSeq: 1 });
  b.send({ type: "relay.resume", streamId, recvSeq: 1, reply: true });
  assert.deepEqual(await a2.nextType("relay.resume"), { type: "relay.resume", streamId, recvSeq: 1, reply: true });
  assert.equal(relayStreams()[0]?.state, "open");
  a2.send({ type: "relay.data", streamId, seq: 2, ack: 1, data: payload });
  assert.equal((await b.nextType("relay.data")).data, payload, "data flows again on the new socket");

  // b ends it cleanly: a is told, and the record holds counts but no content.
  b.send({ type: "relay.close", streamId, reason: "complete" });
  assert.deepEqual(await a2.nextType("relay.close"), { type: "relay.close", streamId, reason: "complete" });
  const row = relayStreams()[0]!;
  assert.deepEqual([row.state, row.close_reason], ["closed", "complete"]);
  assert.ok(row.bytes_up > 0 && row.bytes_down > 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/ssh-relay", headers })).json().active, 0);

  // Revoking the target host ends whatever is open on it.
  a2.send({ type: "relay.connect", requestId: "request-77777", accountId: account.id });
  const second = (await b.nextType("relay.open")).streamId as string;
  b.send({ type: "relay.opened", streamId: second });
  await a2.nextType("relay.opened");
  const revoked = await app.inject({ method: "DELETE", url: "/api/machines/host-b", headers });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await a2.nextType("relay.close")).reason, "machine_revoked");
  assert.equal(relayStreams().at(-1)?.close_reason, "machine_revoked");

  // Every step is on the audit trail, without content.
  const actions = db.all<{ action: string }>("SELECT action FROM audit_entries WHERE action LIKE 'ssh.relay.%' ORDER BY rowid").map(row => row.action);
  assert.ok(actions.includes("ssh.relay.enable") && actions.includes("ssh.relay.open") && actions.includes("ssh.relay.close"));
});

test("the relay switch is an administrator action, off by default, revisioned and per workspace", async t => {
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "test-admin-password-long", PUBLIC_ORIGIN: "http://relay.test", COOKIE_SECURE: "false", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  t.after(() => app.close());
  const auth = new AuthService(db, config);
  const guest = auth.loginVerifiedIdentity({ id: randomUUID(), email: "guest@example.test" }, "127.0.0.1", "test");
  const admin = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "test");
  const headers = (who: typeof admin) => ({ cookie: `${config.cookieName}=${who.sessionToken}`, origin: config.publicOrigin, "x-csrf-token": who.csrfToken });
  assert.equal((await app.inject({ method: "GET", url: "/api/ssh-relay" })).statusCode, 401);
  const view = await app.inject({ method: "GET", url: "/api/ssh-relay", headers: headers(guest) });
  assert.equal(view.statusCode, 200);
  assert.deepEqual([view.json().enabled, view.json().revision, view.json().active], [false, 0, 0], "off by default");
  assert.equal((await app.inject({ method: "PUT", url: "/api/ssh-relay", headers: headers(guest), payload: { enabled: true, revision: 0 } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/ssh-relay", headers: { cookie: headers(admin).cookie, origin: config.publicOrigin }, payload: { enabled: true, revision: 0 } })).statusCode, 403, "CSRF is required");
  const on = await app.inject({ method: "PUT", url: "/api/ssh-relay", headers: headers(admin), payload: { enabled: true, revision: 0 } });
  assert.deepEqual([on.statusCode, on.json().enabled, on.json().revision], [200, true, 1]);
  assert.equal((await app.inject({ method: "PUT", url: "/api/ssh-relay", headers: headers(admin), payload: { enabled: false, revision: 0 } })).statusCode, 409, "a stale tab cannot overwrite");
  assert.equal((await app.inject({ method: "GET", url: "/api/ssh-relay", headers: headers(guest) })).json().enabled, false, "another workspace is unaffected");
});
