import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceGitStatus, WorkspaceGitStatusSampler } from "../src/workspace-git-status.js";

test("detects untracked, staged and unstaged changes and clears after commit in separate worktrees", async t => {
  const temp = await mkdtemp(join(tmpdir(), "pending-commit-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo"), lane = join(temp, "lane");
  await mkdir(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  git(root, "init"); git(root, "config", "user.email", "test@example.test"); git(root, "config", "user.name", "Test");
  await writeFile(join(root, "code.txt"), "base"); git(root, "add", "."); git(root, "commit", "-m", "base");
  git(root, "worktree", "add", "-b", "feature", lane);
  assert.equal((await readWorkspaceGitStatus(root))?.dirty, false);
  await writeFile(join(lane, "new.txt"), "untracked");
  assert.equal((await readWorkspaceGitStatus(lane))?.dirty, true);
  assert.equal((await readWorkspaceGitStatus(root))?.dirty, false);
  git(lane, "add", "."); assert.equal((await readWorkspaceGitStatus(lane))?.dirty, true);
  git(lane, "commit", "-m", "new"); assert.equal((await readWorkspaceGitStatus(lane))?.dirty, false);
  await writeFile(join(lane, "code.txt"), "changed"); assert.equal((await readWorkspaceGitStatus(lane))?.dirty, true);
  assert.equal(await readWorkspaceGitStatus(temp), null);
});

test("sampler deduplicates reads, expires evidence, and never reports a failed check as clean", async () => {
  const time = Date.now(); let calls = 0, fail = false;
  const sampler = new WorkspaceGitStatusSampler(async cwd => {
    calls++;
    if (fail) throw new Error("git unavailable");
    return { cwd, root: cwd, dirty: true, checkedAt: new Date(time).toISOString() };
  });
  await Promise.all([sampler.refresh(["/repo", "/repo"], time), sampler.refresh(["/repo"], time)]);
  assert.equal(calls, 1); assert.equal(sampler.snapshot(time).length, 1);
  await sampler.refresh(["/repo"], time + 1000); assert.equal(calls, 1);
  assert.equal(sampler.snapshot(time + 120_001).length, 0);
  fail = true; await sampler.refresh(["/repo"], time + 31_000);
  assert.deepEqual(sampler.snapshot(time + 31_000), []);
  await sampler.refresh([], time + 62_000); assert.deepEqual(sampler.snapshot(), []);
});
