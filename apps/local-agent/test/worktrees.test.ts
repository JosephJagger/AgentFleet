import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worktrees } from "../src/worktrees.js";
import type { ProjectRecord } from "../src/types.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

async function repository() {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "af-wt-")));
  const root = join(parent, "app");
  await fs.mkdir(root);
  git(root, "init", "-q", "-b", "main");
  await fs.writeFile(join(root, "a.txt"), "one\n");
  await fs.writeFile(join(root, "b.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-q", "-m", "init");
  return { parent, root };
}
const project = (root: string, worktree?: ProjectRecord["worktree"], provider?: ProjectRecord["provider"]): ProjectRecord =>
  ({ id: `proj_${Math.random().toString(36).slice(2)}`, alias: "app", root, device: "1", inode: "1", identityVersion: 1, addedAt: "", source: "explicit", ...(provider ? { provider } : {}), ...(worktree ? { worktree } : {}) });

test("lanes are created beside the repository, reported with overlaps, merged and removed", async () => {
  const { parent, root } = await repository();
  const worktrees = new Worktrees();
  const source = project(root);
  const first = await worktrees.create(source, { name: "codex-login", setup: false, lane: 1 });
  const second = await worktrees.create(source, { name: "claude-refactor", base: "main", setup: false, lane: 2 });
  assert.equal(first.path, join(parent, ".app.worktrees", "codex-login"));
  assert.deepEqual({ ...first.metadata, gitCommonDir: undefined }, { sourceRoot: root, gitCommonDir: undefined, branch: "af/codex-login", base: "main" });
  assert.equal(first.metadata.gitCommonDir, join(root, ".git"));
  await assert.rejects(worktrees.create(source, { name: "codex-login", setup: false, lane: 3 }), /已存在/);
  await assert.rejects(worktrees.create(source, { name: "Bad Name", setup: false, lane: 3 }), /名称/);
  await assert.rejects(worktrees.create(source, { name: "x", base: "missing", setup: false, lane: 3 }), /基础分支不存在/);

  await fs.writeFile(join(first.path, "a.txt"), "codex\n"); git(first.path, "commit", "-qam", "codex change");
  await fs.writeFile(join(second.path, "a.txt"), "claude\n"); git(second.path, "commit", "-qam", "claude change");
  await fs.writeFile(join(second.path, "c.txt"), "draft\n");
  const lanes = [project(first.path, first.metadata, "codex"), project(second.path, second.metadata, "claude")];
  const overview = await worktrees.overview(source, [source, ...lanes]);
  assert.equal(overview.current, "main");
  assert.deepEqual(overview.branches.sort(), ["af/claude-refactor", "af/codex-login", "main"]);
  const codex = overview.lanes.find(lane => lane.branch === "af/codex-login")!;
  assert.deepEqual([codex.ahead, codex.behind, codex.dirtyFiles, codex.providers], [1, 0, 0, ["codex"]]);
  assert.equal(overview.lanes.find(lane => lane.branch === "af/claude-refactor")!.dirtyFiles, 1);
  assert.deepEqual(overview.overlaps, [{ file: "a.txt", branches: ["af/codex-login", "af/claude-refactor"] }]);
  assert.match((await worktrees.diff(lanes[0]!)).patch, /\+codex/);

  await assert.rejects(worktrees.merge(lanes[1]!), /未提交/);
  assert.deepEqual({ ...await worktrees.merge(lanes[0]!), commit: "" }, { merged: true, target: "main", commit: "", branch: "af/codex-login" });
  assert.equal(await fs.readFile(join(root, "a.txt"), "utf8"), "codex\n");
  await assert.rejects(worktrees.merge(lanes[0]!), /没有需要合并/);
  // The second lane now conflicts with main; the merge is refused before touching the main directory.
  await fs.rm(join(second.path, "c.txt"));
  await assert.rejects(worktrees.merge(lanes[1]!), /冲突：a\.txt/);
  assert.equal(git(root, "status", "--porcelain"), "");

  await fs.writeFile(join(second.path, "d.txt"), "unsaved\n");
  await assert.rejects(worktrees.remove(lanes[1]!, { deleteBranch: true, force: false }), /未提交/);
  assert.deepEqual(await worktrees.remove(lanes[1]!, { deleteBranch: true, force: true }), { removed: true, branch: "af/claude-refactor", branchDeleted: false, branchKept: "分支尚未合并，已保留" });
  assert.deepEqual(await worktrees.remove(lanes[0]!, { deleteBranch: true, force: false }), { removed: true, branch: "af/codex-login", branchDeleted: true });
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
});

test("existing worktrees can be adopted, and lanes cannot be used as sources", async () => {
  const { parent, root } = await repository();
  const external = join(parent, "desktop-lane");
  git(root, "worktree", "add", "-q", "-b", "codex/desktop", external);
  const worktrees = new Worktrees();
  const overview = await worktrees.overview(project(root), [project(root)]);
  assert.deepEqual(overview.unmanaged, [{ path: external, branch: "codex/desktop" }]);
  const adopted = await worktrees.create(project(root), { adoptPath: external, setup: false, lane: 1 });
  assert.equal(adopted.metadata.branch, "codex/desktop");
  await assert.rejects(worktrees.create(project(external), { name: "nested", setup: false, lane: 1 }), /主仓库/);
  await assert.rejects(worktrees.create(project(root), { adoptPath: join(parent, "nope"), setup: false, lane: 1 }), /不存在/);
});

test("the setup script runs inside the new lane with its lane number", async () => {
  const { root } = await repository();
  await fs.mkdir(join(root, ".agentfleet"));
  await fs.writeFile(join(root, ".agentfleet", "worktree-setup.sh"), 'echo "lane=$AGENTFLEET_LANE branch=$AGENTFLEET_WORKTREE_BRANCH" > setup.log\necho done\n');
  git(root, "add", "."); git(root, "commit", "-q", "-m", "setup");
  const created = await new Worktrees().create(project(root), { name: "env", setup: true, lane: 4 });
  assert.deepEqual({ ...created.setup, output: created.setup.output?.trim() }, { ran: true, ok: true, output: "done" });
  assert.equal((await fs.readFile(join(created.path, "setup.log"), "utf8")).trim(), "lane=4 branch=af/env");
});


test("dirty tracked paths preserve their first character, spaces and unicode", async () => {
  const { root } = await repository();
  const worktrees = new Worktrees();
  const first = await worktrees.create(project(root), { name: "paths", setup: false, lane: 1 });
  await fs.writeFile(join(first.path, "a.txt"), "changed");
  await fs.writeFile(join(first.path, "中文 name.txt"), "new");
  await fs.writeFile(join(first.path, " leading.txt"), "new");
  const status = await worktrees.status(first.path, first.metadata.branch, "main");
  assert.deepEqual(status.changedFiles.sort(), [" leading.txt", "a.txt", "中文 name.txt"].sort());
});

test("branch changes refuse merge and removal without touching either branch", async () => {
  const { root } = await repository();
  const worktrees = new Worktrees();
  const created = await worktrees.create(project(root), { name: "switched", setup: false, lane: 1 });
  git(created.path, "checkout", "-qb", "unrelated");
  const lane = project(created.path, created.metadata);
  await assert.rejects(worktrees.merge(lane), { code: "WORKTREE_CHANGED" });
  await assert.rejects(worktrees.remove(lane, { deleteBranch: true, force: true }), { code: "WORKTREE_CHANGED" });
  assert.equal(git(created.path, "branch", "--show-current"), "unrelated");
  assert.ok(git(root, "branch", "--list", "af/switched"));
});

test("custom branch names are preserved exactly, checked before creation and independent of the directory name", async t => {
  const { parent, root } = await repository();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const worktrees = new Worktrees();
  const created = await worktrees.create(project(root), { name: "safe-directory", branch: "feat/Login-Fix", base: "main", setup: false, lane: 1 });
  assert.equal(created.metadata.branch, "feat/Login-Fix");
  assert.equal(git(created.path, "branch", "--show-current"), "feat/Login-Fix");
  assert.equal(created.path, join(parent, ".app.worktrees", "safe-directory"));
  assert.equal(git(root, "branch", "--show-current"), "main");
  await assert.rejects(worktrees.create(project(root), { name: "duplicate", branch: "feat/Login-Fix", setup: false, lane: 2 }), { code: "WORKTREE_EXISTS" });
  for (const branch of ["../escape", "main..other", "HEAD", "--help", "foo.lock", "@{-1}"]) {
    await assert.rejects(worktrees.create(project(root), { name: "invalid", branch, setup: false, lane: 2 }), { code: "WORKTREE_NAME_INVALID" });
  }
  await assert.rejects(fs.access(join(parent, ".app.worktrees", "invalid")));
  await assert.rejects(worktrees.create(project(root), { adoptPath: created.path, branch: "other", setup: false, lane: 2 }), { code: "WORKTREE_REQUEST_INVALID" });
});
