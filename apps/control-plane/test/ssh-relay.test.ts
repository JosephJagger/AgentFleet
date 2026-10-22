import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/auth.js";
import { parseInspection, SshAccessService } from "../src/ssh-access.js";
import { RELAY_LIMITS, SshRelayHub, type RelayEndpoint } from "../src/ssh-relay.js";

function keyPair() {
  const root = mkdtempSync(join(tmpdir(), "cp-relay-")); const path = join(root, "key");
  try { execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", path]); return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8").trim() }; }
  finally { rmSync(root, { recursive: true, force: true }); }
}

type Frame = Record<string, unknown>;
interface FakeHost { key: object; ready: boolean; supported: boolean; sent: Frame[]; connected: boolean }

function rig(options: { relayEnabled?: boolean; route?: "relay" | "auto" | "direct"; pin?: boolean; admission?: () => void; now?: () => number } = {}) {
  const db = new ControlPlaneDatabase(":memory:");
  const { workspaceId, userId } = db.bootstrap(loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "relay@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: "http://relay.test", COOKIE_SECURE: "false" }));
  const at = new Date().toISOString();
  for (const machine of ["a", "b", "c", "d"]) {
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at)
      VALUES(?,?,?,?,?,'linux','24','x64','0.30.0','active','normal','online','compatible','idle',?,?)`, machine, workspaceId, `spki-${machine}`, `fp-${machine}`, machine, at, at);
  }
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('csess_t',?,?,'token','csrf',?,?,?)", workspaceId, userId, at, at, at);
  const principal = { userId, workspaceId, clientSessionId: "csess_t", email: "relay@example.test", csrfHash: "", expiresAt: at } as Principal;
  const sshAccess = new SshAccessService(db, ":memory:");
  if (options.relayEnabled !== false) sshAccess.saveRelaySettings(principal, { enabled: true, revision: 0 });
  const pair = keyPair();
  const account = sshAccess.save(principal, { machineId: "b", name: "db", algorithm: "ed25519", username: "deploy", ...pair, ...(options.route === "direct" ? {} : { route: options.route ?? "relay" }), ...(options.relayEnabled === false ? {} : {}) });
  sshAccess.recordInspection(account.id, parseInspection({ userExists: true, authorized: true, hostKeys: options.pin === false ? [] : [keyPair().publicKey], addresses: ["10.0.0.9"], port: 22 }));

  const hosts = new Map<string, FakeHost>();
  const host = (id: string, supported = true): FakeHost => { const value: FakeHost = { key: { id }, ready: true, supported, sent: [], connected: true }; hosts.set(id, value); return value; };
  for (const id of ["a", "b", "c", "d"]) host(id);
  const endpoint = (id: string): RelayEndpoint | undefined => { const h = hosts.get(id); return h && h.connected ? { key: h.key, ready: h.ready, supported: h.supported, send: value => { h.sent.push(JSON.parse(JSON.stringify(value))); return true; } } : undefined; };
  let clock = Date.now();
  const hub = new SshRelayHub({ db, sshAccess, endpoint, limiter: { check() { /* replaced per test when needed */ } }, admission: options.admission ?? (() => undefined), now: options.now ?? (() => clock) });
  const advance = (ms: number) => { clock += ms; };
  const to = (id: string) => hosts.get(id)!;
  const lastOf = (id: string, type: string) => [...to(id).sent].reverse().find(frame => frame.type === type);
  const rows = () => db.all<Record<string, unknown>>("SELECT * FROM ssh_relay_streams ORDER BY started_at");
  const audits = (action: string) => db.all<{ outcome: string; metadata_json: string }>("SELECT outcome,metadata_json FROM audit_entries WHERE action=? ORDER BY rowid", action).map((row): Record<string, unknown> & { outcome: string } => ({ outcome: row.outcome, ...(JSON.parse(row.metadata_json) as Record<string, unknown>) }));
  /** a asks to reach the account on b; returns the stream id once b has accepted. */
  const open = (source = "a") => {
    hub.receive(source, to(source).key, { type: "relay.connect", requestId: "request-0001", accountId: account.id });
    const asked = lastOf("b", "relay.open");
    if (!asked) return undefined;
    const streamId = asked.streamId as string;
    hub.receive("b", to("b").key, { type: "relay.opened", streamId });
    return streamId;
  };
  return { db, principal, sshAccess, hub, hosts, host, to, lastOf, rows, audits, open, advance, account, workspaceId, close: () => { hub.shutdown(); db.close(); } };
}

test("an allowed host opens a stream: the target is told only the stream id, frames pass with validated fields only", t => {
  const r = rig(); t.after(r.close);
  r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: "request-0001", accountId: r.account.id });
  const asked = r.lastOf("b", "relay.open")!;
  assert.deepEqual(Object.keys(asked).sort(), ["streamId", "type"], "the target is never told an address, port, or user");
  assert.equal(r.rows()[0]?.state, "opening");
  r.hub.receive("b", r.to("b").key, { type: "relay.opened", streamId: asked.streamId });
  assert.deepEqual(r.lastOf("a", "relay.opened"), { type: "relay.opened", requestId: "request-0001", streamId: asked.streamId });
  assert.equal(r.rows()[0]?.state, "open");

  const id = asked.streamId as string;
  r.hub.receive("a", r.to("a").key, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: Buffer.from("hello").toString("base64"), host: "10.9.9.9", port: 22, extra: { x: 1 } });
  assert.deepEqual(r.lastOf("b", "relay.data"), { type: "relay.data", streamId: id, seq: 1, ack: 0, data: Buffer.from("hello").toString("base64") }, "unknown fields are dropped, not smuggled through");
  r.hub.receive("b", r.to("b").key, { type: "relay.data", streamId: id, seq: 1, ack: 1, fin: true });
  assert.deepEqual(r.lastOf("a", "relay.data"), { type: "relay.data", streamId: id, seq: 1, ack: 1, fin: true });
  r.hub.receive("a", r.to("a").key, { type: "relay.ack", streamId: id, ack: 1, junk: true });
  assert.deepEqual(r.lastOf("b", "relay.ack"), { type: "relay.ack", streamId: id, ack: 1 });
  assert.equal(r.audits("ssh.relay.open")[0]?.outcome, "success");
  assert.equal(r.audits("ssh.relay.open")[0]?.targetMachineId, "b");
});

test("close frames end the stream for both sides, are recorded with byte counts, and nothing is audited with content", t => {
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  r.hub.receive("a", r.to("a").key, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: Buffer.alloc(3000).toString("base64") });
  r.hub.receive("b", r.to("b").key, { type: "relay.data", streamId: id, seq: 1, ack: 1, data: Buffer.alloc(900).toString("base64") });
  r.hub.receive("a", r.to("a").key, { type: "relay.close", streamId: id, reason: "complete" });
  assert.deepEqual(r.lastOf("b", "relay.close"), { type: "relay.close", streamId: id, reason: "complete" });
  assert.equal(r.hub.active, 0);
  const row = r.rows()[0]!;
  assert.equal(row.state, "closed"); assert.equal(row.close_reason, "complete", "a stream that finished cleanly is recorded as complete");
  // The other end reports the same completion a moment later; it is for a stream that is already gone and changes nothing.
  r.hub.receive("b", r.to("b").key, { type: "relay.close", streamId: id, reason: "complete" });
  assert.equal(r.rows().length, 1);
  assert.equal(row.bytes_up, 3000); assert.equal(row.bytes_down, 900);
  const closed = r.audits("ssh.relay.close")[0]!;
  assert.equal(closed.bytesUp, 3000);
  assert.ok(!JSON.stringify(closed).includes("data"), "the audit trail carries counts, never content");
  r.hub.receive("b", r.to("b").key, { type: "relay.data", streamId: id, seq: 2, ack: 1 });
  r.hub.receive("b", r.to("b").key, { type: "relay.data", streamId: id, seq: 3, ack: 1 });
  assert.equal(r.to("b").sent.filter(frame => frame.reason === "unknown_stream").length, 1, "a host that keeps sending into a closed stream is told once");
});

test("text a target host supplies is stripped of control characters before it reaches another host's terminal", t => {
  const r = rig(); t.after(r.close);
  r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: "request-0001", accountId: r.account.id });
  const id = r.lastOf("b", "relay.open")!.streamId as string;
  r.hub.receive("b", r.to("b").key, { type: "relay.error", streamId: id, code: "target_failed", message: "\u001b[2J\u001b]0;pwned\u0007boom\r\ninjected line" });
  const shown = r.lastOf("a", "relay.error")?.message as string;
  assert.doesNotMatch(shown, /[\u0000-\u001f\u007f]/);
  assert.match(shown, /boom/);
});

test("a stream that ends abnormally is recorded with who ended it and why", t => {
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  r.hub.receive("b", r.to("b").key, { type: "relay.close", streamId: id, reason: "local_error" });
  assert.deepEqual(r.lastOf("a", "relay.close"), { type: "relay.close", streamId: id, reason: "local_error" });
  assert.equal(r.rows()[0]?.close_reason, "target_closed");
  const bad = r.open()!;
  r.hub.receive("a", r.to("a").key, { type: "relay.close", streamId: bad, reason: "Not A Reason!" });
  assert.equal(r.lastOf("b", "relay.close")?.reason, "closed", "a reason that is not a plain word is replaced, never forwarded");
});

test("every reason a connection can be refused is reported to the requester and audited", t => {
  const refused = (r: ReturnType<typeof rig>, source = "a") => {
    r.hub.receive(source, r.to(source).key, { type: "relay.connect", requestId: "request-0001", accountId: r.account.id });
    return { error: r.lastOf(source, "relay.error"), opened: r.lastOf("b", "relay.open"), audit: r.audits("ssh.relay.open").at(-1) };
  };
  {
    const r = rig({ relayEnabled: false, route: "direct" }); t.after(r.close);
    const result = refused(r);
    assert.equal(result.error?.code, "not_allowed"); assert.equal(result.audit?.reason, "not_relay"); assert.equal(result.opened, undefined);
  }
  {
    const r = rig(); t.after(r.close);
    r.sshAccess.saveRelaySettings(r.principal, { enabled: false, revision: 1 });
    assert.equal(refused(r).audit?.reason, "relay_disabled");
  }
  {
    const r = rig({ pin: false }); t.after(r.close);
    assert.equal(refused(r).audit?.reason, "host_key_unpinned", "without a pinned key the panel in the middle could not be detected");
  }
  {
    const r = rig(); t.after(r.close);
    r.sshAccess.save(r.principal, { name: "db", algorithm: "ed25519", username: "deploy", sources: ["c"] }, r.account.id);
    assert.equal(refused(r, "a").audit?.reason, "not_allowed");
    assert.equal(refused(r, "c").opened !== undefined, true, "the host that is allowed still gets through");
  }
  {
    const r = rig(); t.after(r.close);
    r.to("b").connected = false;
    const result = refused(r);
    assert.equal(result.error?.code, "target_offline"); assert.equal(result.audit?.reason, "target_offline");
  }
  {
    const r = rig(); t.after(r.close);
    r.to("b").supported = false;
    assert.equal(refused(r).error?.code, "not_allowed", "a target that cannot carry the relay is excluded by the plan");
  }
  {
    const r = rig({ admission: () => { throw new Error("deploying"); } }); t.after(r.close);
    const result = refused(r);
    assert.equal(result.error?.code, "deployment_wait"); assert.equal(result.opened, undefined);
  }
  {
    const r = rig(); t.after(r.close);
    r.to("a").supported = false;
    assert.equal(refused(r).audit?.reason, "relay_unsupported");
  }
  {
    const r = rig(); t.after(r.close);
    const stale = { id: "old socket" };
    r.hub.receive("a", stale, { type: "relay.connect", requestId: "request-0001", accountId: r.account.id });
    assert.equal(r.lastOf("b", "relay.open"), undefined, "a superseded socket cannot start anything");
    for (const bad of [{ requestId: "x", accountId: r.account.id }, { requestId: "request-0001", accountId: "../etc" }, { requestId: "request-0001" }, { type: "relay.connect" }]) r.hub.receive("a", r.to("a").key, { type: "relay.connect", ...bad });
    assert.equal(r.lastOf("b", "relay.open"), undefined);
    assert.equal(r.rows().length, 0);
  }
});

test("limits per source host, per target host and per workspace, and a rate limit on connects", t => {
  const r = rig(); t.after(r.close);
  const opens = () => r.to("b").sent.filter(frame => frame.type === "relay.open").length;
  for (let i = 0; i < RELAY_LIMITS.perSource; i++) r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: `request-${1000 + i}`, accountId: r.account.id });
  assert.equal(opens(), RELAY_LIMITS.perSource);
  r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: "request-9999", accountId: r.account.id });
  assert.equal(r.lastOf("a", "relay.error")?.code, "busy");
  assert.equal(r.audits("ssh.relay.open").at(-1)?.reason, "per_source_limit");
  assert.equal(opens(), RELAY_LIMITS.perSource, "nothing more was started");

  const limited = rig(); t.after(limited.close);
  const hub = new SshRelayHub({ db: limited.db, sshAccess: limited.sshAccess, endpoint: id => { const h = limited.to(id); return { key: h.key, ready: true, supported: true, send: v => { h.sent.push(v); return true; } }; },
    limiter: { check() { throw new Error("limited"); } }, admission: () => undefined });
  t.after(() => hub.shutdown());
  hub.receive("a", limited.to("a").key, { type: "relay.connect", requestId: "request-0001", accountId: limited.account.id });
  assert.equal(limited.lastOf("a", "relay.error")?.code, "rate_limited");
});

test("a target that cannot reach its sshd, or never answers, fails the request and stops the target", t => {
  mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => mock.timers.reset());
  const r = rig(); t.after(r.close);
  r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: "request-0001", accountId: r.account.id });
  const id = r.lastOf("b", "relay.open")!.streamId as string;
  r.hub.receive("b", r.to("b").key, { type: "relay.error", streamId: id, code: "target_not_listening", message: "sshd is not running" });
  assert.deepEqual(r.lastOf("a", "relay.error"), { type: "relay.error", requestId: "request-0001", code: "target_not_listening", message: "sshd is not running" });
  assert.equal(r.hub.active, 0);
  assert.equal(r.lastOf("b", "relay.close")?.streamId, id, "the target is told to drop a connection it may still be making");
  assert.equal(r.to("a").sent.filter(frame => frame.type === "relay.close").length, 0, "the requester already has its answer");

  r.hub.receive("a", r.to("a").key, { type: "relay.connect", requestId: "request-0002", accountId: r.account.id });
  mock.timers.tick(RELAY_LIMITS.openTimeoutMs + 1);
  assert.equal(r.lastOf("a", "relay.error")?.code, "open_timeout");
  assert.equal(r.hub.active, 0);
  // A late "opened" for the cancelled stream is answered with an instruction to give it up.
  const late = r.to("b").sent.filter(frame => frame.type === "relay.open").at(-1)!.streamId;
  r.hub.receive("b", r.to("b").key, { type: "relay.opened", streamId: late });
  assert.equal(r.to("b").sent.filter(frame => frame.reason === "unknown_stream").length, 1);
  assert.equal(r.rows().every(row => row.state === "closed"), true);
});

test("a dropped WebSocket suspends the stream; the host resumes on its new socket within the grace period", t => {
  mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => mock.timers.reset());
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  const oldKey = r.to("a").key;
  r.hub.disconnect("a", oldKey);
  assert.equal(r.rows()[0]?.state, "suspended");
  assert.equal(r.hub.active, 1, "the stream is kept");
  // While a is away, b's frames cannot be delivered; b keeps them and resends after the resume.
  const before = r.to("a").sent.length;
  r.hub.receive("b", r.to("b").key, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: "AAAA" });
  assert.equal(r.to("a").sent.length, before);

  // a reconnects on a different socket, so frames from the old socket are no longer accepted and the new one is.
  r.to("a").key = { id: "a-second-socket" };
  r.hub.receive("a", oldKey, { type: "relay.resume", streamId: id, recvSeq: 0 });
  assert.equal(r.rows()[0]?.state, "suspended", "a resume from a socket that is no longer the host's current one is ignored");
  r.hub.receive("a", r.to("a").key, { type: "relay.resume", streamId: id, recvSeq: 0 });
  assert.deepEqual(r.lastOf("b", "relay.resume"), { type: "relay.resume", streamId: id, recvSeq: 0 });
  assert.equal(r.rows()[0]?.state, "open");
  r.hub.receive("b", r.to("b").key, { type: "relay.resume", streamId: id, recvSeq: 0, reply: true });
  assert.deepEqual(r.lastOf("a", "relay.resume"), { type: "relay.resume", streamId: id, recvSeq: 0, reply: true });
  r.hub.receive("a", oldKey, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: "BBBB" });
  assert.equal(r.to("b").sent.filter(frame => frame.type === "relay.data").length, 0, "the old socket cannot inject data any more");
  r.hub.receive("a", r.to("a").key, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: "CCCC" });
  assert.equal(r.lastOf("b", "relay.data")?.data, "CCCC");
  mock.timers.tick(RELAY_LIMITS.resumeGraceMs + 1);
  assert.equal(r.hub.active, 1, "resuming cancelled the countdown");
});

test("a host that does not come back in time loses the stream and the other side is told", t => {
  mock.timers.enable({ apis: ["setTimeout"] }); t.after(() => mock.timers.reset());
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  r.hub.disconnect("a", r.to("a").key);
  mock.timers.tick(RELAY_LIMITS.resumeGraceMs - 1);
  assert.equal(r.hub.active, 1);
  mock.timers.tick(2);
  assert.equal(r.hub.active, 0);
  assert.deepEqual(r.lastOf("b", "relay.close"), { type: "relay.close", streamId: id, reason: "resume_timeout" });
  assert.equal(r.rows()[0]?.close_reason, "resume_timeout");
  assert.equal(r.audits("ssh.relay.close")[0]?.reason, "resume_timeout");
  // A resume that arrives after that is answered with "unknown stream" so the host gives up too.
  r.to("a").key = { id: "a-new" };
  r.hub.receive("a", r.to("a").key, { type: "relay.resume", streamId: id, recvSeq: 0 });
  assert.equal(r.lastOf("a", "relay.close")?.reason, "unknown_stream");
});

test("only the two hosts of a stream can use it", t => {
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  const before = JSON.stringify([r.to("a").sent, r.to("b").sent]);
  r.hub.receive("c", r.to("c").key, { type: "relay.data", streamId: id, seq: 1, ack: 0, data: "AAAA" });
  r.hub.receive("c", r.to("c").key, { type: "relay.close", streamId: id, reason: "complete" });
  r.hub.receive("c", r.to("c").key, { type: "relay.resume", streamId: id, recvSeq: 0 });
  assert.equal(r.hub.active, 1);
  assert.equal(JSON.stringify([r.to("a").sent, r.to("b").sent]), before, "nothing reached either end");
});

test("malformed or oversized data closes the stream; so does exceeding the byte rate", t => {
  for (const bad of [{ seq: 0, ack: 0 }, { seq: 1, ack: -1 }, { seq: "1", ack: 0 }, { seq: 1, ack: 0, data: 5 }, { seq: 1, ack: 0, fin: "yes" }, { seq: 1, ack: 0, data: "A".repeat(RELAY_LIMITS.maxDataChars + 1) }]) {
    const r = rig(); t.after(r.close);
    const id = r.open()!;
    r.hub.receive("a", r.to("a").key, { type: "relay.data", streamId: id, ...bad });
    assert.equal(r.hub.active, 0, JSON.stringify(bad).slice(0, 50));
    assert.equal(r.rows()[0]?.close_reason, "protocol");
  }
  const r = rig(); t.after(r.close);
  const id = r.open()!;
  const chunk = "A".repeat(80_000);
  for (let i = 1; i <= 1000 && r.hub.active; i++) r.hub.receive("a", r.to("a").key, { type: "relay.data", streamId: id, seq: i, ack: 0, data: chunk });
  assert.equal(r.rows()[0]?.close_reason, "rate_limited");
});

test("a stream that has gone quiet, or has lived too long, is closed", t => {
  let clock = 5_000_000;
  const idle = rig({ now: () => clock }); t.after(idle.close);
  idle.open();
  const housekeeping = () => (idle.hub as unknown as { housekeeping(): void }).housekeeping();
  clock += RELAY_LIMITS.idleMs - 1000; housekeeping();
  assert.equal(idle.hub.active, 1);
  clock += 2000; housekeeping();
  assert.equal(idle.hub.active, 0);
  assert.equal(idle.rows()[0]?.close_reason, "idle_timeout");

  const old = rig({ now: () => clock }); t.after(old.close);
  const id = old.open()!;
  for (let spent = 0; spent < RELAY_LIMITS.maxLifetimeMs + 60_000; spent += 10 * 60_000) {
    clock += 10 * 60_000;
    old.hub.receive("a", old.to("a").key, { type: "relay.data", streamId: id, seq: spent / 600_000 + 1, ack: 0, data: "AAAA" });
    (old.hub as unknown as { housekeeping(): void }).housekeeping();
  }
  assert.equal(old.rows()[0]?.close_reason, "max_lifetime", "activity does not make a stream immortal");
});

test("what stops a stream: the switch turned off, the account removed or rerouted, the host revoked", t => {
  const cases: Array<[string, (r: ReturnType<typeof rig>) => void, string]> = [
    ["switch off", r => { r.sshAccess.saveRelaySettings(r.principal, { enabled: false, revision: 1 }); r.hub.reevaluate(r.workspaceId, "relay_settings"); }, "relay_settings"],
    ["account removed", r => { r.sshAccess.remove(r.principal, r.account.id); r.hub.reevaluate(r.workspaceId, "account_removed"); }, "account_removed"],
    ["account made direct", r => { r.sshAccess.save(r.principal, { name: "db", algorithm: "ed25519", username: "deploy", route: "direct" }, r.account.id); r.hub.reevaluate(r.workspaceId, "account_changed"); }, "account_changed"],
    ["account disabled", r => { r.sshAccess.save(r.principal, { name: "db", algorithm: "ed25519", username: "deploy", enabled: false }, r.account.id); r.hub.reevaluate(r.workspaceId, "account_changed"); }, "account_changed"],
    ["source no longer allowed", r => { r.sshAccess.save(r.principal, { name: "db", algorithm: "ed25519", username: "deploy", sources: ["c"] }, r.account.id); r.hub.reevaluate(r.workspaceId, "account_changed"); }, "account_changed"],
    ["host revoked", r => r.hub.closeMachine("b", "machine_revoked"), "machine_revoked"],
  ];
  for (const [label, change, reason] of cases) {
    const r = rig(); t.after(r.close);
    const id = r.open()!;
    change(r);
    assert.equal(r.hub.active, 0, label);
    assert.equal(r.rows()[0]?.close_reason, reason, label);
    assert.equal(r.lastOf("a", "relay.close")?.streamId, id, `${label}: both hosts are told`);
    assert.equal(r.lastOf("b", "relay.close")?.streamId, id, label);
  }
  const untouched = rig(); t.after(untouched.close);
  untouched.open();
  untouched.sshAccess.save(untouched.principal, { name: "db", algorithm: "ed25519", username: "deploy", description: "unrelated edit" }, untouched.account.id);
  untouched.hub.reevaluate(untouched.workspaceId, "account_changed");
  assert.equal(untouched.hub.active, 1, "an edit that does not change what is allowed keeps the stream");
});

test("a restarted panel closes what a dead process left open, so the publisher never waits on ghosts", t => {
  const r = rig(); t.after(r.close);
  const stamp = new Date().toISOString();
  r.db.run("INSERT INTO ssh_relay_streams(stream_id,workspace_id,account_id,source_machine_id,target_machine_id,state,started_at,last_active_at) VALUES('rs_ghost',?,?,'a','b','open',?,?)", r.workspaceId, r.account.id, stamp, stamp);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  r.db.run("INSERT INTO ssh_relay_streams(stream_id,workspace_id,account_id,source_machine_id,target_machine_id,state,started_at,last_active_at,closed_at,close_reason) VALUES('rs_old',?,?,'a','b','closed',?,?,?,'idle_timeout')", r.workspaceId, r.account.id, old, old, old);
  const next = new SshRelayHub({ db: r.db, sshAccess: r.sshAccess, endpoint: () => undefined, limiter: { check() { /* none */ } }, admission: () => undefined });
  t.after(() => next.shutdown());
  assert.equal(r.db.get<{ n: number }>("SELECT count(*) AS n FROM ssh_relay_streams WHERE closed_at IS NULL")?.n, 0);
  assert.equal(r.db.get<{ close_reason: string }>("SELECT close_reason FROM ssh_relay_streams WHERE stream_id='rs_ghost'")?.close_reason, "panel_restart");
  assert.equal(r.db.get("SELECT 1 AS x FROM ssh_relay_streams WHERE stream_id='rs_old'"), undefined, "old history is pruned");
});

test("the workspace switch is revisioned and audited, and choosing the relay needs it on", t => {
  const r = rig({ relayEnabled: false, route: "direct" }); t.after(r.close);
  assert.deepEqual({ ...r.sshAccess.relaySettings(r.principal) }, { enabled: false, revision: 0, updatedAt: null });
  assert.throws(() => r.sshAccess.save(r.principal, { machineId: "c", name: "other", algorithm: "ed25519", username: "u", ...keyPair(), route: "relay" }), /请先启用面板中转/);
  const on = r.sshAccess.saveRelaySettings(r.principal, { enabled: true, revision: 0 });
  assert.deepEqual([on.enabled, on.revision], [true, 1]);
  assert.throws(() => r.sshAccess.saveRelaySettings(r.principal, { enabled: false, revision: 0 }), /reload before saving/, "a stale tab cannot overwrite a newer setting");
  assert.throws(() => r.sshAccess.saveRelaySettings(r.principal, { enabled: "yes", revision: 1 }), /请选择是否启用面板中转/);
  assert.throws(() => r.sshAccess.saveRelaySettings(r.principal, { enabled: true, revision: 1, extra: 1 }), /请选择是否启用面板中转/);
  r.sshAccess.saveRelaySettings(r.principal, { enabled: false, revision: 1 });
  assert.deepEqual(r.audits("ssh.relay.enable").length + r.audits("ssh.relay.disable").length, 2);
  // An account that already uses the relay can still be edited while the switch is off; it is just not delivered.
  r.sshAccess.saveRelaySettings(r.principal, { enabled: true, revision: 2 });
  const account = r.sshAccess.save(r.principal, { machineId: "c", name: "cc", algorithm: "ed25519", username: "u", ...keyPair(), route: "auto" });
  r.sshAccess.saveRelaySettings(r.principal, { enabled: false, revision: 3 });
  assert.equal(r.sshAccess.save(r.principal, { name: "cc", algorithm: "ed25519", username: "u", description: "edit" }, account.id).route, "auto");
  assert.deepEqual(r.sshAccess.desired("a", false).filter(item => item.id === account.id), [], "while it is off, no host is given a relay account");
});
