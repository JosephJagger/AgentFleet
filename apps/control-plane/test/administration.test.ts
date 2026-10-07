import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AuthService } from "../src/auth.js";
import { buildControlPlane } from "../src/server.js";
import { loadConfig } from "../src/config.js";

test("platform administration is isolated, paginated, CSRF protected and revokes disabled identities", async t => {
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "test-admin-password-long", PUBLIC_ORIGIN: "http://admin.test", COOKIE_SECURE: "false", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  t.after(() => app.close());
  const auth = new AuthService(db, config);
  const identity = { id: randomUUID(), email: "guest@example.test" };
  const guest = auth.loginVerifiedIdentity(identity, "127.0.0.1", "test");
  const admin = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "test");
  const headers = (credentials: typeof admin) => ({ cookie: `${config.cookieName}=${credentials.sessionToken}`, origin: config.publicOrigin, "x-csrf-token": credentials.csrfToken });
  assert.equal(db.get<{ role: string }>("SELECT role FROM users WHERE user_id=?", guest.principal.userId)!.role, "admin", "workspace admin does not grant platform admin");
  for (const url of ["/api/admin/users", "/api/admin/system", "/api/release", "/api/runtime-release"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: { ...headers(guest), "x-platform-admin": "true" } })).statusCode, 403, url);
    assert.equal((await app.inject({ method: "GET", url, headers: headers(admin) })).statusCode, 200, url);
  }
  const stamp = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES('guest-machine',?,'key','guest-fingerprint','Private host','linux','test','x64',?,?)`, guest.principal.workspaceId, stamp, stamp);
  assert.equal((await app.inject({ method: "GET", url: "/api/machines/guest-machine", headers: headers(admin) })).statusCode, 404, "platform admin cannot browse another workspace");
  assert.equal((await app.inject({ method: "GET", url: "/api/machines/guest-machine", headers: headers(guest) })).statusCode, 200);
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: headers(guest) });
  assert.equal(me.json().user.platformAdmin, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/status", headers: headers(admin) })).json().user.platformAdmin, true);
  // Automatic agents can still obtain public, non-secret release artifacts.
  assert.equal((await app.inject({ method: "GET", url: "/api/runtime-release/target" })).statusCode, 200);
  const url = `/api/admin/users/${guest.principal.userId}/actions`;
  const mutate = (action: string) => app.inject({ method: "POST", url, headers: headers(admin), payload: { action } });
  assert.equal((await app.inject({ method: "POST", url, headers: headers(guest), payload: { action: "disable" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url, headers: { cookie: headers(admin).cookie, origin: config.publicOrigin }, payload: { action: "disable" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url, headers: { ...headers(admin), origin: "https://evil.test" }, payload: { action: "disable" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/users/${admin.principal.userId}/actions`, headers: headers(admin), payload: { action: "disable" } })).statusCode, 409);
  assert.equal((await mutate("promote-admin")).statusCode, 400);
  await app.ready();
  const socket = await app.injectWS("/ws/client", { headers: headers(guest) });
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  assert.equal((await mutate("disable")).statusCode, 200);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Disabled browser socket remained open")), 2000); timer.unref(); })]);
  assert.equal((await app.inject({ method: "GET", url: "/api/dashboard", headers: headers(guest) })).statusCode, 401);
  assert.throws(() => auth.loginVerifiedIdentity(identity, "127.0.0.1", "test"), /disabled/);
  assert.equal((await mutate("enable")).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: headers(guest) })).statusCode, 401, "re-enable never restores revoked sessions");
  const renewed = auth.loginVerifiedIdentity(identity, "127.0.0.1", "test");
  assert.equal((await app.inject({ method: "GET", url: "/api/dashboard", headers: headers(renewed) })).statusCode, 200);
  assert.equal((await mutate("revoke-sessions")).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/dashboard", headers: headers(renewed) })).statusCode, 401);
  for (let i = 0; i < 11; i++) auth.loginVerifiedIdentity({ id: randomUUID(), email: `person${i}@example.test` }, "127.0.0.1", "test");
  const list = await app.inject({ method: "GET", url: "/api/admin/users", headers: headers(admin) });
  assert.equal(list.json().users.length, 10); assert.equal(list.json().total, 13); assert.equal(list.json().pages, 2);
  assert.deepEqual(Object.keys(list.json().users[0]).sort(), ["id", "email", "createdAt", "lastLoginAt", "disabled", "platformAdmin", "machineCount"].sort());
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/users?page=2", headers: headers(admin) })).json().users.length, 3);
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/users?search=%25", headers: headers(admin) })).json().total, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/users?page=NaN", headers: headers(admin) })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/users?search=guest%40", headers: headers(admin) })).json().total, 1);
  const audit = db.all<{ action: string }>("SELECT action FROM audit_entries WHERE action LIKE 'admin.user.%'");
  assert.equal(audit.length, 3);
});

test("system release follows the published channel after startup and never falls back on channel failure", async t => {
  const { createServer } = await import("node:http");
  let version = "0.30.81", available = true;
  const channel = createServer((_req, res) => {
    if (!available) { res.writeHead(503); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({schemaVersion:1, version, artifacts:{linux:{file:"agent.tar.gz",sha256:"a".repeat(64),size:1}}}));
  });
  await new Promise<void>(resolve => channel.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>(resolve => channel.close(() => resolve())));
  const address = channel.address() as { port: number };
  const config = loadConfig({ AUTH_MODE:"password", ADMIN_EMAIL:"owner@example.test", ADMIN_PASSWORD:"test-admin-password-long", PUBLIC_ORIGIN:"http://admin.test", COOKIE_SECURE:"false", DATABASE_PATH:":memory:", LOG_LEVEL:"silent", AGENTFLEET_RELEASE_MANIFEST_URL:`http://127.0.0.1:${address.port}/manifest.json` });
  const {app,db} = await buildControlPlane(config);
  t.after(() => app.close());
  const auth = new AuthService(db,config);
  const admin=auth.login(config.adminEmail,config.adminPassword,"127.0.0.1","test");
  const read=async()=>(await app.inject({method:"GET",url:"/api/release",headers:{cookie:`${config.cookieName}=${admin.sessionToken}`}})).json();
  assert.equal((await read()).agentVersion,"0.30.81");
  version="0.30.82";
  assert.equal((await read()).agentVersion,"0.30.82");
  available=false;
  assert.equal((await read()).agentVersion,null);
  assert.notEqual((await read()).agentManifest.status,"ready");
});
