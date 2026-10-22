import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/auth.js";
import { MaintenanceService } from "../src/maintenance.js";
import { parseWorktreeTarget, WorktreeService } from "../src/worktrees.js";

function fixture() {
  const db = new ControlPlaneDatabase(":memory:");
  const { workspaceId, userId } = db.bootstrap(loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "wt@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: "http://wt.test", COOKIE_SECURE: "false" }));
  const at = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at,maintenance_types_json) VALUES('m',?,'k','f','m','linux','6','x64','1','active','normal','online','compatible','idle',?,?,?)`, workspaceId, at, at, JSON.stringify(["worktree.create", "worktree.merge", "worktree.remove"]));
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('cs',?,?,'t','c',?,?,?)", workspaceId, userId, at, at, at);
  const project = (id: string, provider: string, root: string, lane?: { repoRoot: string; branch: string; base: string; removed?: boolean }) => db.run(
    `INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at,provider,repo_root,branch,worktree_base,worktree_removed) VALUES(?,?,'m',?,?,?,?,?,?,?,?,?,?,?)`,
    id, workspaceId, `ext-${id}`, id, root, `hash-${id}`, at, at, provider, lane?.repoRoot ?? null, lane?.branch ?? null, lane?.base ?? null, lane?.removed ? 1 : 0);
  project("main-codex", "codex", "/srv/app");
  project("main-claude", "claude", "/srv/app", { repoRoot: "/srv/app", branch: "main", base: "" });
  project("lane-codex", "codex", "/srv/.app.worktrees/login", { repoRoot: "/srv/app", branch: "af/login", base: "main" });
  project("lane-grok", "grok", "/srv/.app.worktrees/login", { repoRoot: "/srv/app", branch: "af/login", base: "main" });
  project("lane-claude", "claude", "/srv/.app.worktrees/refactor", { repoRoot: "/srv/app", branch: "af/refactor", base: "main" });
  project("lane-gone", "codex", "/srv/.app.worktrees/old", { repoRoot: "/srv/app", branch: "af/old", base: "main", removed: true });
  const session = (id: string, projectId: string, running: boolean) => db.run(
    `INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,active_turn_id,created_at,updated_at) VALUES(?,?,'m',?,?,1,?,'live',?,?,?)`,
    id, workspaceId, projectId, `session ${id}`, running ? "running" : "idle", running ? "turn" : null, at, at);
  const principal = { userId, workspaceId, clientSessionId: "cs", email: "wt@example.test", csrfHash: "", expiresAt: at } as Principal;
  return { db, principal, session, service: new WorktreeService(db), maintenance: new MaintenanceService(db) };
}

test("lanes group every agent registered in one worktree directory under the main repository", () => {
  const { principal, service, session } = fixture();
  session("s1", "lane-codex", false); session("s2", "lane-grok", true);
  assert.equal(service.main(principal, "lane-claude").project_id, "main-claude", "a lane resolves to the same agent's main project");
  assert.equal(service.main(principal, "lane-grok").project_id, "main-codex", "falls back to any main project at that root");
  const overview = service.overview(principal, "main-codex", {
    current: "main", branches: ["main", "af/login"], mainDirtyFiles: 0, setupScript: true,
    lanes: [{ path: "/srv/.app.worktrees/login", exists: true, dirtyFiles: 2, ahead: 3, behind: 1, changedFiles: ["a.ts"], lastCommit: "fix" }],
    overlaps: [{ file: "a.ts", branches: ["af/login", "af/refactor"] }], unmanaged: [{ path: "/srv/desktop", branch: "codex/x" }],
  });
  assert.deepEqual(overview.lanes.map(lane => [lane.path, lane.projects.map(project => project.provider), lane.sessions.length, lane.ahead]),
    [["/srv/.app.worktrees/login", ["codex", "grok"], 2, 3], ["/srv/.app.worktrees/refactor", ["claude"], 0, 0]]);
  assert.equal(overview.lanes[0]!.sessions.find(item => item.id === "s2")!.running, true);
  assert.equal(overview.setupScript, true);
  assert.deepEqual(overview.unmanaged, [{ path: "/srv/desktop", branch: "codex/x" }]);
  assert.throws(() => service.lane(principal, "main-codex"), /不是工作树/);
  assert.throws(() => service.lane(principal, "lane-gone"), /不存在/);
});

test("create targets are derived from trusted project rows and validated", () => {
  const { principal, service } = fixture();
  const { machineId, target } = service.createTarget(principal, "lane-codex", { provider: "claude", name: "api-v2", base: "main", setup: true });
  assert.equal(machineId, "m");
  assert.deepEqual(target, { projectExternalId: "ext-main-codex", provider: "claude", alias: "main-codex-api-v2", name: "api-v2", base: "main", setup: true });
  assert.match(String(service.createTarget(principal, "main-codex", { provider: "codex" }).target.name), /^codex-[0-9a-f]{6}$/);
  assert.deepEqual(service.createTarget(principal, "main-codex", { provider: "grok", adoptPath: "/srv/.app.worktrees/login" }).target,
    { projectExternalId: "ext-main-codex", provider: "grok", alias: "main-codex-login", adoptPath: "/srv/.app.worktrees/login", setup: false });
  assert.throws(() => service.createTarget(principal, "main-codex", { provider: "codex", name: "Bad Name" }), /工作树名称/);
  assert.throws(() => service.createTarget(principal, "main-codex", { provider: "codex", name: "x", base: "../etc" }), /基础分支/);
  assert.throws(() => service.createTarget(principal, "main-codex", { provider: "nope", name: "x" }), /Unknown agent provider/);
  assert.throws(() => parseWorktreeTarget("worktree.create", { projectExternalId: "e", provider: "codex", alias: "a", name: "x", adoptPath: "/p" }), /名称，或选择已有/);
});

test("merge waits for both directories, removal only for the lane; operations are idempotent", () => {
  const { principal, service, session, maintenance } = fixture();
  session("busy-main", "main-claude", true);
  assert.throws(() => service.laneTarget(principal, "lane-codex", "worktree.merge", {}), /主目录中仍有任务/);
  const removal = service.laneTarget(principal, "lane-codex", "worktree.remove", { deleteBranch: true });
  assert.deepEqual(removal.target, { projectExternalId: "ext-lane-codex", deleteBranch: true, force: false });
  session("busy-lane", "lane-grok", true);
  assert.throws(() => service.laneTarget(principal, "lane-codex", "worktree.remove", {}), /工作树中仍有任务/, "the lock spans every agent in the lane directory");

  const first = maintenance.create(principal, "m", "worktree.remove", "mutation-1", undefined, undefined, undefined, removal.target);
  assert.equal(maintenance.create(principal, "m", "worktree.remove", "mutation-1", undefined, undefined, undefined, removal.target).operationId, first.operationId);
  assert.throws(() => maintenance.create(principal, "m", "worktree.remove", "mutation-1", undefined, undefined, undefined, { ...removal.target, force: true }), /clientMutationId/);
  const offer = maintenance.offers("m")[0]!;
  assert.deepEqual([offer.operationType, offer.recoveryTarget], ["worktree.remove", removal.target]);
});

test("creation results resolve registered project IDs without trusting host IDs and catch up after hello", t => {
  const { db, principal, service, maintenance } = fixture();
  t.after(() => db.close());
  const { target } = service.createTarget(principal, "main-codex", { provider: "codex", name: "new-lane" });
  const operation = maintenance.create(principal, "m", "worktree.create", "create-project-id", undefined, undefined, undefined, target);
  maintenance.result("m", String(operation.operationId), "succeeded", { projectExternalId: "not-yet-registered", projectId: "host-untrusted" }, undefined);
  const result = () => maintenance.get(principal, String(operation.operationId)).result as Record<string, unknown>;
  assert.equal(result().projectId, undefined);
  db.run("UPDATE projects SET external_id='not-yet-registered' WHERE project_id='lane-codex'");
  assert.equal(result().projectId, "lane-codex");
  db.run("UPDATE projects SET provider='claude' WHERE project_id='lane-codex'");
  assert.equal(result().projectId, undefined, "a host result cannot silently switch the requested provider");
  db.run("UPDATE projects SET provider='codex' WHERE project_id='lane-codex'");
  db.run("UPDATE projects SET worktree_removed=1 WHERE project_id='lane-codex'");
  assert.equal(result().projectId, undefined);
  assert.throws(() => maintenance.get({ ...principal, workspaceId: "other-workspace" }, String(operation.operationId)), /not found/);

  db.run("UPDATE machines SET maintenance_types_json='[\"project.add\"]' WHERE machine_id='m'");
  const added = maintenance.create(principal, "m", "project.add", "add-project-id", undefined, undefined, { path: "/srv/app", alias: "app", createDirectory: false });
  maintenance.result("m", String(added.operationId), "succeeded", { projectExternalId: "ext-main-codex" }, undefined);
  assert.equal((maintenance.get(principal, String(added.operationId)).result as Record<string, unknown>).projectId, "main-codex");
});

test("adoption accepts absolute Windows and POSIX paths and refuses relative paths", () => {
  for (const adoptPath of ["C:\\projects\\lane", "\\\\server\\share\\lane", "/srv/lane"]) {
    assert.equal(parseWorktreeTarget("worktree.create", { projectExternalId: "p", provider: "codex", alias: "lane", adoptPath }).adoptPath, adoptPath);
  }
  for (const adoptPath of ["lane", "C:lane"]) assert.throws(() => parseWorktreeTarget("worktree.create", { projectExternalId: "p", provider: "codex", alias: "lane", adoptPath }));
});

test("custom branch names survive target building and old agents cannot silently ignore them", () => {
  const { db, principal, service, maintenance } = fixture();
  const { target } = service.createTarget(principal, "main-codex", { provider: "claude", branch: "feat/Login-Fix", base: "main", setup: false });
  assert.equal(target.branch, "feat/Login-Fix");
  db.run("UPDATE machines SET agent_version='0.30.140' WHERE machine_id='m'");
  assert.throws(() => maintenance.create(principal, "m", "worktree.create", "custom-old", undefined, undefined, undefined, target), /0.30.141/);
  db.run("UPDATE machines SET agent_version='0.30.141' WHERE machine_id='m'");
  maintenance.create(principal, "m", "worktree.create", "custom-new", undefined, undefined, undefined, target);
  assert.equal((maintenance.offers("m")[0]!.recoveryTarget as Record<string, unknown>).branch, "feat/Login-Fix");
  for (const branch of ["../escape", "main..other", "HEAD", "--help", "foo.lock", "x//y", "x/"]) {
    assert.throws(() => service.createTarget(principal, "main-codex", { provider: "claude", branch }));
  }
  assert.throws(() => service.createTarget(principal, "main-codex", { provider: "claude", adoptPath: "/srv/desktop", branch: "feat/new" }));
});

test("copying a conversation into a lane validates the source session and tells the host which native thread to fork", () => {
  const { db, principal, session, service } = fixture();
  const segment = (sessionId: string, projectId: string, nativeThreadId: string | null, ended = false) => db.run(
    "INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,created_at,ended_at) VALUES(?,?,'m',?,?,?,?,?)",
    `seg-${sessionId}`, sessionId, projectId, `ext-seg-${sessionId}`, nativeThreadId, new Date().toISOString(), ended ? new Date().toISOString() : null);
  session("idle-main", "main-codex", false); segment("idle-main", "main-codex", "native-main");
  session("idle-lane", "lane-codex", false); segment("idle-lane", "lane-codex", "native-lane");
  session("busy", "main-codex", true); segment("busy", "main-codex", "native-busy");
  session("claude", "main-claude", false); segment("claude", "main-claude", "native-claude");
  session("lane-claude-session", "lane-claude", false); segment("lane-claude-session", "lane-claude", "native-lane-claude");
  session("ended", "main-codex", false); segment("ended", "main-codex", "native-ended", true);
  session("unmanaged", "main-codex", false); segment("unmanaged", "main-codex", "native-unmanaged"); db.run("UPDATE logical_sessions SET managed=0 WHERE logical_session_id='unmanaged'");
  const fork = (forkSessionId: unknown, provider = "codex") => service.createTarget(principal, "main-codex", { provider, name: "copy", forkSessionId });

  assert.equal(fork("idle-main").target.forkNativeThreadId, "native-main");
  assert.equal(service.createTarget(principal, "lane-codex", { provider: "codex", name: "copy", forkSessionId: "idle-lane" }).target.forkNativeThreadId, "native-lane", "a session inside a lane can be copied into a sibling lane");
  assert.equal("forkNativeThreadId" in service.createTarget(principal, "main-codex", { provider: "codex", name: "blank" }).target, false);

  assert.throws(() => fork("busy"), /正在执行/);
  assert.throws(() => fork("ended"), /不存在/);
  assert.throws(() => fork("unmanaged"), /先接管并同步/);
  assert.throws(() => fork("nope"), /不存在/);
  assert.throws(() => fork(42), /原会话无效/);
  assert.throws(() => fork("claude"), /只有 Codex/);
  assert.throws(() => fork("idle-main", "claude"), /只有 Codex/);
  assert.throws(() => fork("lane-claude-session"), /只有 Codex/);
  db.run("INSERT INTO project_turn_reservations(project_id,logical_session_id,state,version,reserved_at,updated_at) VALUES('main-codex','idle-main','accepted',1,'x','x')");
  assert.throws(() => fork("idle-main"), /正在执行/, "a session with a reserved turn is not idle");

  const other = { ...principal, workspaceId: "other-workspace" } as Principal;
  assert.throws(() => service.createTarget(other, "main-codex", { provider: "codex", forkSessionId: "idle-lane" }), /项目不存在/);
  assert.throws(() => parseWorktreeTarget("worktree.create", { projectExternalId: "e", provider: "codex", alias: "a", adoptPath: "/p", forkNativeThreadId: "t" }), /只有 Codex/);
  assert.throws(() => parseWorktreeTarget("worktree.create", { projectExternalId: "e", provider: "grok", alias: "a", name: "x", forkNativeThreadId: "t" }), /只有 Codex/);
});

test("project catalog pages complete repository families and pins a selected off-page family", async t => {
  const { projectCatalog } = await import("../src/project-catalog.js");
  const { db, principal, session } = fixture(); t.after(() => db.close());
  session("running", "lane-codex", true);
  session("waiting", "lane-codex", false);
  session("deleted", "lane-codex", true);
  db.run("UPDATE logical_sessions SET execution_state='awaiting_approval' WHERE logical_session_id='waiting'");
  db.run("UPDATE logical_sessions SET deleted_at='2026-01-01' WHERE logical_session_id='deleted'");
  const options = { machineId: "m", limit: 1 };
  const first = projectCatalog(db, principal, options);
  assert.equal(first.total, 3, "two agent-specific roots and one orphan worktree");
  assert.deepEqual(first.items.map(p => p.projectId), ["lane-grok"], "an unmatched worktree remains visible");
  assert.equal(first.items[0]!.parentProjectId, null);
  const second = projectCatalog(db, principal, { ...options, offset: 1 });
  assert.deepEqual(second.items.map(p => [p.projectId, p.parentProjectId]), [["lane-claude", "main-claude"], ["main-claude", null]]);
  const pinned = projectCatalog(db, principal, options, "lane-codex");
  assert.equal(pinned.total, 3, "pinning does not inflate page count");
  assert.deepEqual(new Set(pinned.items.map(p => p.projectId)), new Set(["lane-grok", "main-codex", "lane-codex"]));
  assert.deepEqual(pinned.items.find(p => p.projectId === "lane-codex")!.activity, { running: 1, waiting: 1, uncertain: 0 });
  const codex = projectCatalog(db, principal, { ...options, provider: "codex" }, "lane-claude");
  assert.equal(codex.total, 1);
  assert.deepEqual(codex.items.map(p => p.projectId), ["lane-codex", "main-codex"], "pin cannot bypass provider filtering; removed lanes stay hidden");
  assert.equal(projectCatalog(db, principal, { ...options, machineId: "other" }, "lane-codex").items.length, 0);
  assert.equal(projectCatalog(db, { ...principal, workspaceId: "other" }, options, "lane-codex").items.length, 0);
  db.run("UPDATE machines SET identity_state='revoked' WHERE machine_id='m'");
  assert.equal(projectCatalog(db, principal, options, "lane-codex").total, 0);
});
