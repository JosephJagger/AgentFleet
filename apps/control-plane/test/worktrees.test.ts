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
