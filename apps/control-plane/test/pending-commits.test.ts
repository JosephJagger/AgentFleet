import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/auth.js";
import { RegistryService } from "../src/registry.js";
import { dismissPendingCommit, pendingCommits, parseWorkspaceGitStatus } from "../src/pending-commits.js";

function fixture(t: test.TestContext, path = ":memory:") {
  const db = new ControlPlaneDatabase(path); t.after(() => db.close());
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "pending@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: "http://test.local", COOKIE_SECURE: "false" });
  const { workspaceId, userId } = db.bootstrap(config);
  const at = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at) VALUES('m',?,'k','f','host','linux','6','x64','1','active','normal','online','compatible','idle',?,?)`, workspaceId, at, at);
  const add = (id: string, root: string, provider = "codex", state = "completed", updated = at) => {
    db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at,provider) VALUES(?,?,'m',?,?,?,?,?,?,?)`, id, workspaceId, id, id, root, id, at, at, provider);
    db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'m',?,?,1,?,'live',?,?)`, id, workspaceId, id, `task ${id}`, state, at, updated);
  };
  const report = (entries: unknown[]) => db.run("UPDATE machines SET discovery_json=? WHERE machine_id='m'", JSON.stringify({ workspaceGitStatus: entries }));
  const status = (root: string, dirty = true, checkedAt = at) => ({ cwd: root, root, dirty, checkedAt });
  const principal = { workspaceId, userId, clientSessionId: "test" } as Principal;
  return { db, add, report, status, principal, at, registry: new RegistryService(db, config) };
}

test("main and worktree reminders are separate, providers in one directory are deduplicated and scoped", t => {
  const { db, add, report, status, principal, at } = fixture(t);
  add("old", "/repo", "codex", "completed", "2020-01-01T00:00:00Z"); add("recent", "/repo", "claude"); add("lane", "/lane");
  report([status("/repo"), status("/lane")]);
  assert.deepEqual(pendingCommits(db, principal, Date.parse(at)).map(r => r.logicalSessionId).sort(), ["lane", "recent"]);
  assert.equal(pendingCommits(db, { ...principal, workspaceId: "another" }).length, 0);
  add("running", "/repo", "grok", "running");
  assert.deepEqual(pendingCommits(db, principal, Date.parse(at)).map(r => r.logicalSessionId), ["lane"]);
});

test("committing clears reminders; unknown, stale, offline, archived and deleted evidence does not create tasks", t => {
  const { db, add, report, status, principal, at } = fixture(t); add("s", "/repo");
  report([status("/repo", false)]); assert.equal(pendingCommits(db, principal).length, 0);
  report([status("/repo", true, "2020-01-01T00:00:00Z")]); assert.equal(pendingCommits(db, principal).length, 0);
  report([status("/repo")]); assert.equal(pendingCommits(db, principal, Date.parse(at)).length, 1);
  db.run("UPDATE machines SET reachability='offline'"); assert.equal(pendingCommits(db, principal).length, 0);
  db.run("UPDATE machines SET reachability='online'");
  db.run("UPDATE logical_sessions SET runtime_settings_json=?", JSON.stringify({ archived: true })); assert.equal(pendingCommits(db, principal).length, 0);
  db.run("UPDATE logical_sessions SET runtime_settings_json=NULL,deleted_at=?", at); assert.equal(pendingCommits(db, principal).length, 0);
});

test("new idle sessions are not called completed and the newest directory sample wins", t => {
  const { db, add, report, status, principal, at } = fixture(t);
  add("done", "/repo"); add("idle", "/new", "claude", "idle");
  report([status("/repo"), status("/new"), { ...status("/repo", false, new Date(Date.parse(at) + 1).toISOString()), cwd: "/repo/subdir" }]);
  assert.equal(pendingCommits(db, principal, Date.parse(at)).length, 0);
  assert.deepEqual(parseWorkspaceGitStatus([null, {}, { cwd: "/repo", root: "/repo", dirty: "yes", checkedAt: at }]), []);
});


test("host discovery keeps only Git metadata and dashboard exposes reminders independently of approval count", t => {
  const { db, add, status, principal, at, registry } = fixture(t);
  add("s", "/repo");
  db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,created_at) VALUES('seg','s','m','s',?)", at);
  registry.updateDiscovery("m", { state: "ready", workspaceGitStatus: [{ ...status("/repo"), content: "must not store file contents" }] });
  const stored = db.get<{ discovery_json: string }>("SELECT discovery_json FROM machines WHERE machine_id='m'")!;
  assert.equal(stored.discovery_json.includes("must not store"), false);
  const dashboard = registry.dashboard(principal);
  assert.equal((dashboard.counts as Record<string, number>).pendingCommits, 1);
  assert.equal((dashboard.counts as Record<string, number>).pendingApprovals, 0);
  assert.equal((dashboard.pendingCommits as Array<{ logicalSessionId: string }>)[0]?.logicalSessionId, "s");
  registry.updateDiscovery("m", { state: "ready", workspaceGitStatus: [status("/repo", false)] });
  assert.deepEqual(registry.dashboard(principal).pendingCommits, []);
});


test("dismissal survives refresh and new sessions, is per-account, and new work reappears", t => {
  const { db, add, report, status, principal, at } = fixture(t); add("s", "/repo");
  db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,created_at) VALUES('seg','s','m','s',?)", at);
  const fingerprint = "a".repeat(64), next = "b".repeat(64);
  report([{ ...status("/repo"), fingerprint }]);
  const item = pendingCommits(db, principal)[0]!;
  assert.equal(item.dismissalToken, fingerprint);
  dismissPendingCommit(db, principal, { id: item.id, token: item.dismissalToken });
  dismissPendingCommit(db, principal, { id: item.id, token: item.dismissalToken }); // retry is idempotent
  assert.deepEqual(pendingCommits(db, principal), []);
  report([{ ...status("/repo", true, new Date(Date.parse(at) + 1).toISOString()), fingerprint }]);
  add("new-session", "/repo", "claude");
  assert.deepEqual(pendingCommits(db, { ...principal, clientSessionId: "another-browser" }), []);
  assert.equal(pendingCommits(db, { ...principal, userId: "another-user" }).length, 1);
  report([{ ...status("/repo"), fingerprint: next }]);
  assert.equal(pendingCommits(db, principal).length, 1);
  assert.throws(() => dismissPendingCommit(db, principal, { id: item.id, token: fingerprint }), /提醒已变化/);
  assert.equal(pendingCommits(db, principal)[0]!.dismissalToken, next);
  assert.throws(() => dismissPendingCommit(db, { ...principal, workspaceId: "another" }, { id: item.id, token: next }), /提醒已变化/);
  assert.equal(db.get<{token: string}>("SELECT token FROM pending_commit_dismissals")!.token, fingerprint);
});

test("legacy, invalid, stale and busy samples cannot be dismissed", t => {
  const { db, add, report, status, principal } = fixture(t); add("s", "/repo");
  const token = "a".repeat(64);
  for (const fingerprint of [undefined, "bad", "a".repeat(65)]) {
    report([{ ...status("/repo"), fingerprint }]);
    assert.equal(pendingCommits(db, principal)[0]?.dismissalToken, undefined);
    assert.throws(() => dismissPendingCommit(db, principal, { id: "m:/repo", token }), /提醒已变化/);
  }
  report([{ ...status("/repo", true, "2020-01-01"), fingerprint: token }]);
  assert.throws(() => dismissPendingCommit(db, principal, { id: "m:/repo", token }), /提醒已变化/);
  report([{ ...status("/repo"), fingerprint: token }]); add("running", "/repo", "claude", "running");
  assert.throws(() => dismissPendingCommit(db, principal, { id: "m:/repo", token }), /提醒已变化/);
  assert.equal(db.all("SELECT * FROM pending_commit_dismissals").length, 0);
});

test("dismiss endpoint requires login and CSRF and validates the observed revision", async t => {
  const { buildControlPlane, cookieFromSetCookie, csrfHeaders } = await import("../src/server.js");
  const password = randomUUID(), origin = "http://test.local";
  const { app } = await buildControlPlane({ ...loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "pending@example.test", ADMIN_PASSWORD: password, DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: ":memory:" });
  t.after(() => app.close());
  const url = "/api/pending-commits/dismiss", payload = {id: "m:/repo", token: "a".repeat(64)};
  const anonymous = await app.inject({method: "POST", url, headers: {origin}, payload});
  assert.equal(anonymous.statusCode, 401);
  const login = await app.inject({method: "POST", url: "/api/auth/login", headers: {origin}, payload: {email: "pending@example.test", password}});
  assert.equal(login.statusCode, 200);
  const cookie = cookieFromSetCookie(login.headers["set-cookie"]);
  assert.equal((await app.inject({method: "POST", url, headers: {origin, cookie}, payload})).statusCode, 403);
  const headers = {...csrfHeaders(login.json().csrfToken, origin), cookie};
  assert.equal((await app.inject({method: "POST", url, headers, payload: {id: payload.id, token: "bad"}})).statusCode, 400);
  assert.equal((await app.inject({method: "POST", url, headers, payload})).statusCode, 409);
});


test("dismissals are durable across database connections", t => {
  const directory = mkdtempSync(join(tmpdir(), "dismiss-pending-"));
  const path = join(directory, "db.sqlite");
  const { db, add, report, status, principal } = fixture(t, path);
  add("s", "/repo"); report([{ ...status("/repo"), fingerprint: "a".repeat(64) }]);
  const item = pendingCommits(db, principal)[0]!;
  dismissPendingCommit(db, principal, {id: item.id, token: item.dismissalToken});
  const reopened = new ControlPlaneDatabase(path);
  try { assert.deepEqual(pendingCommits(reopened, principal), []); }
  finally { reopened.close(); }
  t.after(() => rmSync(directory, {recursive: true, force: true}));
});
