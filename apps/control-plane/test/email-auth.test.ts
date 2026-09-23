import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";

test("email mode is the default and requires the Django service, never a password fallback", () => {
  assert.throws(() => loadConfig({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "legacy-admin-password" }), /DJANGO_AUTH/);
  const config = loadConfig({ ADMIN_EMAIL: "admin@example.com", DJANGO_AUTH_URL: "http://127.0.0.1:8000", DJANGO_AUTH_SERVICE_TOKEN: "s".repeat(48) });
  assert.equal(config.authMode, "email");
  assert.equal(config.adminPassword, "");
});

test("Django-verified identities preserve the owner and isolate new users, sessions and resources", async t => {
  const origin = "http://email.test", serviceToken = "s".repeat(48);
  const identities = new Map<string, { id: string; email: string }>();
  let latestChallenge = "";
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${serviceToken}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("request-code")) {
      latestChallenge = randomUUID();
      identities.set(latestChallenge, { id: randomUUID(), email: body.email.toLowerCase() });
      res.end(JSON.stringify({ challengeId: latestChallenge, expiresIn: 600, resendAfter: 60 }));
    } else if (body.code === "123456" && identities.has(body.challengeId)) {
      res.end(JSON.stringify({ user: identities.get(body.challengeId) }));
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "INVALID_OR_EXPIRED_CODE" } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  const config = loadConfig({ ADMIN_EMAIL: "owner@example.com", DJANGO_AUTH_URL: `http://127.0.0.1:${address.port}`,
    DJANGO_AUTH_SERVICE_TOKEN: serviceToken, DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" });
  config.databasePath = ":memory:";
  const { app, db } = await buildControlPlane(config);
  t.after(() => app.close());
  const original = db.get<{ user_id: string; workspace_id: string }>("SELECT user_id,workspace_id FROM users")!;
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/request-code", payload: { email: "owner@example.com" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "owner@example.com", password: "legacy-admin-password" } })).statusCode, 403);
  async function login(email: string) {
    const request = await app.inject({ method: "POST", url: "/api/auth/request-code", headers: { origin }, payload: { email, locale: "zh" } });
    assert.equal(request.statusCode, 200, request.body);
    assert.equal(request.body.includes("123456"), false);
    const response = await app.inject({ method: "POST", url: "/api/auth/verify-code", headers: { origin }, payload: { challengeId: request.json().challengeId, code: "123456" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
    return { ...response.json(), headers: { cookie: cookieFromSetCookie(response.headers["set-cookie"]), ...csrfHeaders(response.json().csrfToken, origin) } };
  }
  const owner = await login("OWNER@example.com");
  assert.equal(owner.user.userId, original.user_id);
  assert.equal(owner.user.workspaceId, original.workspace_id);
  const guest = await login("guest@example.com");
  assert.notEqual(guest.user.workspaceId, owner.user.workspaceId);
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM workspaces")!.n, 2);
  const again = await app.inject({ method: "POST", url: "/api/auth/verify-code", headers: { origin }, payload: { challengeId: latestChallenge, code: "123456" } });
  assert.equal(again.json().user.userId, guest.user.userId, "the same Django identity maps to the same local user");
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM users")!.n, 2);
  const now = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES('private-machine',?,'key','fingerprint','Owner machine','linux','test','x64',?,?)`, original.workspace_id, now, now);
  assert.equal((await app.inject({ method: "GET", url: "/api/machines", headers: owner.headers })).json().machines.length, 1);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/machines", headers: guest.headers })).json().machines, []);
  for (const url of ["/api/machines/private-machine", "/api/machines/private-machine/codex-settings", "/api/machines/private-machine/images"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: guest.headers })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: "DELETE", url: "/api/machines/private-machine", headers: guest.headers, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/client-sessions/${owner.clientSessionId}`, headers: guest.headers, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/runtime-release/control", headers: guest.headers, payload: { action: "pause" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: guest.headers.cookie, origin } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: guest.headers, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: guest.headers })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: owner.headers })).statusCode, 200);
  assert.deepEqual(db.bootstrap(config), { workspaceId: original.workspace_id, userId: original.user_id });
  const invalid = await app.inject({ method: "POST", url: "/api/auth/verify-code", headers: { origin }, payload: { challengeId: latestChallenge, code: "999999" } });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.headers["set-cookie"], undefined);
});
