import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AuthService } from "../src/auth.js";
import { buildControlPlane } from "../src/server.js";
import { loadConfig } from "../src/config.js";

test("SSH verify and test are administrator actions and rate limited", async t => {
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "test-admin-password-long", PUBLIC_ORIGIN: "http://ssh.test", COOKIE_SECURE: "false", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  t.after(() => app.close());
  const auth = new AuthService(db, config);
  const guest = auth.loginVerifiedIdentity({ id: randomUUID(), email: "guest@example.test" }, "127.0.0.1", "test");
  const admin = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "test");
  const headers = (credentials: typeof admin) => ({ cookie: `${config.cookieName}=${credentials.sessionToken}`, origin: config.publicOrigin, "x-csrf-token": credentials.csrfToken });
  const post = (who: typeof admin, action: string, id = "ssh_missing") => app.inject({ method: "POST", url: `/api/ssh-accounts/${id}/${action}`, headers: headers(who) });

  for (const action of ["verify", "test"]) {
    assert.equal((await app.inject({ method: "POST", url: `/api/ssh-accounts/ssh_missing/${action}` })).statusCode, 401, `${action} needs a session`);
    // The authority check comes before any account lookup, so a workspace member learns nothing about accounts either.
    const denied = await post(guest, action);
    assert.equal(denied.statusCode, 403, `${action} must be refused to a workspace member`);
    assert.equal(denied.json().error?.code ?? denied.json().code, "ADMIN_REQUIRED");
    assert.equal((await post(admin, action)).statusCode, 404, `${action} reaches the account lookup for an administrator`);
  }

  // Administrative remote-effect actions are bounded per user.
  for (let i = 0; i < 9; i++) assert.equal((await post(admin, "test")).statusCode, 404);
  assert.equal((await post(admin, "test")).statusCode, 429, "the eleventh test within a minute is limited");
  assert.equal((await post(guest, "test")).statusCode, 403, "a refused member is not rate limited into a different answer");
});

test("the interconnect matrix needs a session and only shows the caller's workspace", async t => {
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: "test-admin-password-long", PUBLIC_ORIGIN: "http://ssh.test", COOKIE_SECURE: "false", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  t.after(() => app.close());
  const auth = new AuthService(db, config);
  const guest = auth.loginVerifiedIdentity({ id: randomUUID(), email: "guest@example.test" }, "127.0.0.1", "test");
  const admin = auth.login(config.adminEmail, config.adminPassword, "127.0.0.1", "test");
  const headers = (credentials: typeof admin) => ({ cookie: `${config.cookieName}=${credentials.sessionToken}`, origin: config.publicOrigin, "x-csrf-token": credentials.csrfToken });
  const stamp = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at)
    VALUES('guest-mac',?,'k1','f1','Guest Mac','darwin','27','arm64','0.30.0','active','normal','online','compatible','idle',?,?),
          ('guest-win',?,'k2','f2','Guest Win','win32','11','x64','0.30.0','active','normal','online','compatible','idle',?,?)`, guest.principal.workspaceId, stamp, stamp, guest.principal.workspaceId, stamp, stamp);

  assert.equal((await app.inject({ method: "GET", url: "/api/ssh-links" })).statusCode, 401);
  const own = await app.inject({ method: "GET", url: "/api/ssh-links", headers: headers(guest) });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.json().hosts.map((host: { machineId: string; supported: boolean }) => [host.machineId, host.supported]).sort(), [["guest-mac", true], ["guest-win", false]]);
  assert.deepEqual(own.json().links, []);
  const other = await app.inject({ method: "GET", url: "/api/ssh-links", headers: headers(admin) });
  assert.equal(other.statusCode, 200);
  assert.ok(!JSON.stringify(other.json()).includes("guest-"), "another workspace's hosts never appear");
});
