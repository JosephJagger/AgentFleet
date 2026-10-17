import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { requiresPlatformAdmin } from "../src/maintenance.js";

test("only version-control operations that change panel-distributed software need the platform administrator", () => {
  assert.equal(requiresPlatformAdmin("agent.update", undefined), true);
  assert.equal(requiresPlatformAdmin("provider.runtime", { action: "confirm", provider: "codex", version: "0.163.0" }), true);
  for (const request of [{ action: "check" }, { action: "update", provider: "claude", expectedRevision: 1 }, { action: "configure", provider: "claude", mode: "host", expectedRevision: 1 }, { action: "rollback", provider: "claude", expectedRevision: 1 }, undefined, "nonsense"])
    assert.equal(requiresPlatformAdmin("provider.runtime", request), false, JSON.stringify(request));
  for (const type of ["catalog.refresh", "connection.repair", "diagnostics.collect", "versions.clean"]) assert.equal(requiresPlatformAdmin(type, undefined), false, type);
});

test("Codex confirmation and Agent updates are refused for everyone but the configured administrator", async t => {
  const origin = "http://versions.test", password = "isolated-version-control-password", email = "operator@example.test";
  const result = await buildControlPlane({ ...loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: email, ADMIN_PASSWORD: password, PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: ":memory:" });
  t.after(() => result.app.close());
  const login = await result.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email, password } });
  const headers = { cookie: cookieFromSetCookie(login.headers["set-cookie"]), ...csrfHeaders(login.json().csrfToken, origin) };
  const { db, app, config } = result;
  const workspace = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const now = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at,reachability,compatibility,capacity,last_heartbeat_at,maintenance_types_json)
    VALUES('host-a',?,'a','a','host-a','linux','fixture','x64',?,?,'online','compatible','idle',?,?)`, workspace, now, now, now, JSON.stringify(["agent.update", "provider.runtime"]));
  const start = (type: string, nativeRequest?: unknown) => app.inject({ method: "POST", url: "/api/machines/host-a/operations", headers, payload: { type, nativeRequest, clientMutationId: crypto.randomUUID() } });
  const confirm = { action: "confirm", provider: "codex", version: "0.163.0" };

  // The same logged-in session, once it is no longer the administrator account.
  (config as { adminEmail: string }).adminEmail = "someone-else@example.test";
  for (const [type, request] of [["agent.update", undefined], ["provider.runtime", confirm]] as const) {
    const refused = await start(type, request);
    assert.equal(refused.statusCode, 403, `${type}: ${refused.body}`);
    assert.equal(refused.json().error?.code ?? refused.json().code, "ADMIN_REQUIRED");
  }
  assert.equal(db.get<{ n: number }>("SELECT count(*) n FROM machine_operations")!.n, 0, "a refused request leaves no operation behind");
  // Claude policy is the host owner's own decision and stays available to members.
  const check = await start("provider.runtime", { action: "check" });
  assert.equal(check.statusCode, 202, check.body);

  db.run("UPDATE machine_operations SET state='succeeded'");
  (config as { adminEmail: string }).adminEmail = email;
  const accepted = await start("provider.runtime", confirm);
  assert.equal(accepted.statusCode, 202, accepted.body);
});
