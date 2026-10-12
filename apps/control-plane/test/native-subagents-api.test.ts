import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane, csrfHeaders } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { AuthService } from "../src/auth.js";
import { RegistryService } from "../src/registry.js";
import { NativeSubagentsBroker } from "../src/native-subagents-broker.js";
import type { HistoryBinding } from "../src/session-history.js";

const result = { provider: "codex", items: [{ id: "child", title: "Native child", status: "running" }], nextCursor: null };
async function fixture(t: TestContext) {
  const origin = "http://subagents.test";
  const config = { ...loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "subagents@example.test", ADMIN_PASSWORD: "subagents-fixture-password", PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: ":memory:" };
  const { app, db } = await buildControlPlane(config); t.after(() => app.close());
  const auth = new AuthService(db, config), login = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "fixture"), at = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Host','linux','24','x64','0.30.97','online','compatible','[]',?,?,?)`, login.principal.workspaceId, at, at, at);
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','external','Demo','/fixture','hash',?,?)", login.principal.workspaceId, at, at);
  const registry = new RegistryService(db, config), session = registry.createSession(login.principal, "m", "p", "Main", "fixture-session");
  db.run("UPDATE logical_sessions SET managed=1 WHERE logical_session_id=?", session.logicalSessionId);
  db.run("UPDATE execution_segments SET native_thread_id='native-parent' WHERE logical_session_id=?", session.logicalSessionId);
  const headers = { cookie: `${config.cookieName}=${login.sessionToken}`, ...csrfHeaders(login.csrfToken, origin) }, url = `/api/sessions/${session.logicalSessionId}/subagents`;
  const read = (payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers, payload });
  return { app, db, auth, login, config, headers, url, session, read };
}

test("subagent reads require authentication, same-origin CSRF, ownership, managed session and content sharing", async t => {
  const f = await fixture(t), calls = t.mock.method(NativeSubagentsBroker.prototype, "read", async () => result);
  assert.equal((await f.app.inject({ method: "POST", url: f.url, payload: {} })).statusCode, 401);
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: { cookie: f.headers.cookie }, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: { ...f.headers, origin: "http://other.test" }, payload: {} })).statusCode, 403);
  const guest = f.auth.loginVerifiedIdentity({ id: "guest", email: "guest@example.test" }, "127.0.0.1", "fixture");
  assert.equal((await f.app.inject({ method: "POST", url: f.url, headers: { cookie: `${f.config.cookieName}=${guest.sessionToken}`, ...csrfHeaders(guest.csrfToken, f.config.publicOrigin) }, payload: {} })).statusCode, 404);
  f.db.run("UPDATE logical_sessions SET managed=0"); assert.equal((await f.read()).json().error.code, "SUBAGENTS_NOT_MANAGED");
  f.db.run("UPDATE logical_sessions SET managed=1"); f.db.run("UPDATE projects SET sync_content=0");
  assert.equal((await f.read()).json().error.code, "SUBAGENTS_CONTENT_DISABLED"); assert.equal(calls.mock.callCount(), 0);
});

test("subagent endpoint validates inputs and binds a passive read to the current native session", async t => {
  const f = await fixture(t), calls = t.mock.method(NativeSubagentsBroker.prototype, "read", async () => result);
  for (const payload of [{ prompt: "must-not-dispatch" }, { childId: "" }, { childId: "child\nother" }, { childId: "x".repeat(257) }, { cursor: "" }, { cursor: 42 }, { cursor: "x".repeat(12001) }]) assert.equal((await f.read(payload)).statusCode, 400);
  assert.equal(calls.mock.callCount(), 0);
  const response = await f.read(); assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "no-store"); assert.deepEqual(response.json(), result);
  const [binding, input] = calls.mock.calls[0]!.arguments as unknown as [HistoryBinding, Record<string, unknown>];
  assert.equal(binding.sessionId, f.session.logicalSessionId); assert.equal(binding.machineId, "m"); assert.equal(binding.projectExternalId, "external"); assert.equal(binding.nativeThreadId, "native-parent"); assert.equal(binding.executionSegmentId, f.session.executionSegmentId); assert.equal(binding.contentEpoch, 1); assert.deepEqual(input, {});
  assert.equal(f.db.get<{ n: number }>("SELECT count(*) n FROM commands")?.n, 0); assert.equal(f.db.get<{ n: number }>("SELECT count(*) n FROM panel_voice_jobs")?.n, 0);
});

test("content revocation, release and epoch changes while awaiting native reply suppress the result", async t => {
  const f = await fixture(t);
  for (const sql of ["UPDATE projects SET sync_content=0", "UPDATE logical_sessions SET managed=0", "UPDATE logical_sessions SET content_epoch=content_epoch+1"]) {
    const call = t.mock.method(NativeSubagentsBroker.prototype, "read", async () => { f.db.run(sql); return result; });
    const response = await f.read(); assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, "SUBAGENTS_TARGET_CHANGED"); assert.ok(!response.body.includes("Native child"));
    call.mock.restore(); f.db.run("UPDATE projects SET sync_content=1"); f.db.run("UPDATE logical_sessions SET managed=1");
  }
});

test("revoking the signed-in browser while a native read is pending blocks its response", async t => {
  const f = await fixture(t);
  t.mock.method(NativeSubagentsBroker.prototype, "read", async () => { f.db.run("UPDATE client_sessions SET revoked_at=? WHERE client_session_id=?", new Date().toISOString(), f.login.principal.clientSessionId); return result; });
  const response = await f.read(); assert.equal(response.statusCode, 401, response.body); assert.ok(!response.body.includes("Native child"));
});

test("native provider mismatch is rejected and unavailable hosts do not create work", async t => {
  const f = await fixture(t);
  const call = t.mock.method(NativeSubagentsBroker.prototype, "read", async () => ({ ...result, provider: "claude" }));
  const wrong = await f.read(); assert.equal(wrong.statusCode, 502); assert.equal(wrong.json().error.code, "SUBAGENTS_INVALID"); call.mock.restore();
  const offline = await f.read(); assert.equal(offline.statusCode, 409); assert.equal(offline.json().error.code, "SUBAGENTS_HOST_OFFLINE");
  assert.equal(f.db.get<{ n: number }>("SELECT count(*) n FROM commands")?.n, 0);
});

test("removed shared browser and manual collaboration endpoints cannot dispatch legacy tasks", async t => {
  const f = await fixture(t);
  for (const url of [`/api/sessions/${f.session.logicalSessionId}/browser`, "/api/collaboration", "/api/collaboration/prepare", "/api/collaboration/old-task/dispatch", "/api/collaboration/old-task/collect"]) {
    const response = await f.app.inject({ method: "POST", url, headers: f.headers, payload: {} });
    assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
  }
  assert.equal(f.db.get<{ n: number }>("SELECT count(*) n FROM commands")?.n, 0);
});
