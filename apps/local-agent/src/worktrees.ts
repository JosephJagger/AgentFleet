import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { AgentError } from "./errors.js";
import type { ProjectRecord } from "./types.js";
import { isRecord } from "./util.js";

/**
 * Git worktrees let several agents work on one repository at once: each lane is its own directory, so the
 * per-directory turn lock never serializes them. The panel creates, inspects, merges and removes lanes here.
 */
export interface WorktreeMetadata { sourceRoot: string; gitCommonDir: string; branch: string; base: string; removedAt?: string }
type Run = (args: string[], cwd: string, options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; command?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_FILES = 300;
const MAX_PATCH = 150_000;
export const SETUP_SCRIPT = ".agentfleet/worktree-setup.sh";

const defaultRun: Run = (args, cwd, options = {}) => new Promise(resolve => {
  execFile(options.command ?? "git", options.command ? args : ["-C", cwd, ...args], {
    cwd, timeout: options.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...options.env },
  }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 255) : 0;
    resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
  });
});

const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
/** Porcelain -z preserves leading spaces, unicode and newlines; rename records have a second source path. */
function dirtyPaths(output: string): string[] {
  const entries = output.split("\0"), paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) { const source = entries[++i]; if (source) paths.push(source); }
  }
  return [...new Set(paths)];
}
const tail = (text: string, max = 4000) => text.length > max ? `…${text.slice(-max)}` : text;
const failure = (code: string, message: string, detail?: string) => new AgentError(code, detail ? `${message}：${detail.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? ""}` : message);

export interface LaneStatus {
  path: string; branch: string; base: string; exists: boolean; dirtyFiles: number; ahead: number; behind: number;
  changedFiles: string[]; lastCommit: string; providers: string[];
}

export class Worktrees {
  constructor(private readonly run: Run = defaultRun) {}

  private async git(cwd: string, args: string[], code: string, message: string, timeoutMs?: number) {
    const result = await this.run(args, cwd, { ...(timeoutMs ? { timeoutMs } : {}) });
    if (result.code !== 0) throw failure(code, message, result.stderr || result.stdout);
    return result.stdout;
  }

  /** The main worktree of a registered project, with its shared git directory. */
  async repository(root: string) {
    const result = await this.run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], root);
    if (result.code !== 0) throw new AgentError("WORKTREE_NOT_GIT", "项目不是 Git 仓库");
    const [top, commonDir, current] = lines(result.stdout);
    if (!top || !commonDir) throw new AgentError("WORKTREE_NOT_GIT", "项目不是 Git 仓库");
    const canonicalTop = await realpath(top);
    const canonicalCommon = await realpath(commonDir);
    if (canonicalTop !== root) throw new AgentError("WORKTREE_SOURCE_INVALID", "请从仓库根目录的项目创建工作树");
    if (dirname(canonicalCommon) !== canonicalTop) throw new AgentError("WORKTREE_SOURCE_INVALID", "该项目本身是工作树，请从主仓库创建");
    return { root: canonicalTop, gitCommonDir: canonicalCommon, current: current === "HEAD" ? null : current ?? null };
  }

  laneDirectory(sourceRoot: string, name: string) { return join(dirname(sourceRoot), `.${basename(sourceRoot)}.worktrees`, name); }

  async branches(root: string) {
    const output = await this.git(root, ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "--count=200", "refs/heads"], "WORKTREE_GIT_FAILED", "读取分支失败");
    return lines(output);
  }

  /** Worktrees git knows about for this repository, including ones made by Codex desktop or by hand. */
  async registered(root: string): Promise<{ path: string; branch: string | null }[]> {
    const output = await this.git(root, ["worktree", "list", "--porcelain"], "WORKTREE_GIT_FAILED", "读取工作树失败");
    const result: { path: string; branch: string | null }[] = [];
    for (const block of output.split("\n\n")) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || /^prunable/m.test(block)) continue;
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
      result.push({ path: await realpath(path).catch(() => path), branch });
    }
    return result;
  }

  async status(path: string, branch: string, base: string): Promise<Omit<LaneStatus, "providers">> {
    const exists = await access(path).then(() => true, () => false);
    if (!exists) return { path, branch, base, exists, dirtyFiles: 0, ahead: 0, behind: 0, changedFiles: [], lastCommit: "" };
    const [status, counts, committed, last] = await Promise.all([
      this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], path),
      this.run(["rev-list", "--left-right", "--count", `${base}...HEAD`], path),
      this.run(["diff", "--name-only", "-z", `${base}...HEAD`], path),
      this.run(["log", "-1", "--format=%s"], path),
    ]);
    const dirty = dirtyPaths(status.stdout);
    const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    return {
      path, branch, base, exists, dirtyFiles: dirty.length, ahead: ahead || 0, behind: behind || 0,
      changedFiles: [...new Set([...committed.stdout.split("\0").filter(Boolean), ...dirty])].slice(0, MAX_FILES), lastCommit: last.stdout.trim().slice(0, 200),
    };
  }

  /** Branches, lanes and file overlaps between lanes, for one main repository. */
  async overview(source: ProjectRecord, projects: readonly ProjectRecord[]) {
    const repository = await this.repository(source.root);
    const lanes = new Map<string, ProjectRecord[]>();
    for (const project of projects) {
      if (project.worktree?.sourceRoot !== repository.root || project.worktree.removedAt) continue;
      lanes.set(project.root, [...(lanes.get(project.root) ?? []), project]);
    }
    const statuses: LaneStatus[] = await Promise.all([...lanes].map(async ([path, records]) => ({
      ...await this.status(path, records[0]!.worktree!.branch, records[0]!.worktree!.base), providers: records.map(record => record.provider ?? "codex"),
    })));
    const owners = new Map<string, string[]>();
    for (const lane of statuses) for (const file of lane.changedFiles) owners.set(file, [...(owners.get(file) ?? []), lane.branch]);
    const overlaps = [...owners].filter(([, branches]) => branches.length > 1).slice(0, 100).map(([file, branches]) => ({ file, branches }));
    const unmanaged = (await this.registered(repository.root)).filter(item => item.path !== repository.root && !lanes.has(item.path));
    const mainStatus = await this.run(["status", "--porcelain=v1", "--untracked-files=no"], repository.root);
    return {
      root: repository.root, current: repository.current, branches: await this.branches(repository.root), mainDirtyFiles: lines(mainStatus.stdout).length,
      customBranchNames: true,
      setupScript: await access(join(repository.root, SETUP_SCRIPT)).then(() => true, () => false),
      lanes: statuses, overlaps, unmanaged,
    };
  }

  async diff(lane: ProjectRecord) {
    const worktree = lane.worktree!;
    const [stat, committed, uncommitted, status] = await Promise.all([
      this.run(["diff", "--stat", `${worktree.base}...HEAD`], lane.root),
      this.run(["diff", "--no-color", `${worktree.base}...HEAD`], lane.root),
      this.run(["diff", "--no-color", "HEAD"], lane.root),
      this.run(["status", "--porcelain=v1", "--untracked-files=all"], lane.root),
    ]);
    const patch = `${committed.stdout}${uncommitted.stdout ? `\n# 未提交的改动\n${uncommitted.stdout}` : ""}`;
    return { branch: worktree.branch, base: worktree.base, stat: tail(stat.stdout, 20_000), status: lines(status.stdout).slice(0, MAX_FILES),
      patch: patch.length > MAX_PATCH ? patch.slice(0, MAX_PATCH) : patch, truncated: patch.length > MAX_PATCH };
  }

  /** Creates a lane from a local branch, or adopts an existing worktree of the same repository. */
  async create(source: ProjectRecord, request: { name?: string; branch?: string; base?: string; adoptPath?: string; setup: boolean; lane: number }) {
    const repository = await this.repository(source.root);
    let path: string; let branch: string; let base: string;
    if (request.adoptPath) {
      if (request.branch !== undefined) throw new AgentError("WORKTREE_REQUEST_INVALID", "接入已有工作树不能更改分支");
      if (!isAbsolute(request.adoptPath)) throw new AgentError("WORKTREE_PATH_INVALID", "工作树路径无效");
      const adopted = (await this.registered(repository.root)).find(item => item.path === request.adoptPath && item.path !== repository.root);
      if (!adopted) throw new AgentError("WORKTREE_CHANGED", "该工作树已不存在，请刷新后重试");
      if (!adopted.branch) throw new AgentError("WORKTREE_DETACHED", "该工作树没有检出分支，无法接入");
      path = adopted.path; branch = adopted.branch; base = request.base ?? repository.current ?? adopted.branch;
    } else {
      if (!request.name || !NAME.test(request.name)) throw new AgentError("WORKTREE_NAME_INVALID", "工作树名称仅支持小写字母、数字、点、下划线和连字符");
      base = request.base ?? repository.current ?? "";
      if (!base || (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`], repository.root)).code !== 0) throw new AgentError("WORKTREE_BASE_INVALID", "基础分支不存在");
      branch = request.branch ?? `af/${request.name}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch === "HEAD") throw new AgentError("WORKTREE_NAME_INVALID", "新分支名称无效");
      if ((await this.run(["check-ref-format", "--branch", branch], repository.root)).code !== 0) throw new AgentError("WORKTREE_NAME_INVALID", "工作树名称不能作为分支名");
      if ((await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repository.root)).code === 0) throw new AgentError("WORKTREE_EXISTS", `分支 ${branch} 已存在，请换一个名称`);
      path = this.laneDirectory(repository.root, request.name);
      if (await access(path).then(() => true, () => false)) throw new AgentError("WORKTREE_EXISTS", "同名工作树目录已存在，请换一个名称");
      await mkdir(dirname(path), { recursive: true });
      await this.git(repository.root, ["worktree", "add", "-b", branch, path, base], "WORKTREE_CREATE_FAILED", "创建工作树失败", 120_000);
      path = await realpath(path);
    }
    let setup: { ran: boolean; ok?: boolean; output?: string } = { ran: false };
    const script = join(path, SETUP_SCRIPT);
    if (request.setup && await access(script).then(() => true, () => false)) {
      const result = await this.run([script], path, { command: "sh", timeoutMs: 15 * 60_000,
        env: { AGENTFLEET_WORKTREE_SOURCE: repository.root, AGENTFLEET_WORKTREE_BRANCH: branch, AGENTFLEET_LANE: String(request.lane) } });
      setup = { ran: true, ok: result.code === 0, output: tail(`${result.stdout}${result.stderr}`) };
    }
    return { path, metadata: { sourceRoot: repository.root, gitCommonDir: repository.gitCommonDir, branch, base } satisfies WorktreeMetadata, setup };
  }

  private async verifyLane(lane: ProjectRecord) {
    const metadata = lane.worktree!;
    const repository = await this.repository(metadata.sourceRoot);
    const registered = (await this.registered(metadata.sourceRoot)).find(item => item.path === lane.root);
    if (repository.gitCommonDir !== metadata.gitCommonDir || !registered || registered.branch !== metadata.branch) {
      throw new AgentError("WORKTREE_CHANGED", "工作树目录或分支已变化，请先核对并重新接入后操作");
    }
  }

  /** Merges a lane's commits into whatever the main worktree has checked out, refusing rather than clobbering. */
  async merge(lane: ProjectRecord) {
    const { sourceRoot, branch } = lane.worktree!;
    await this.verifyLane(lane);
    if (lines(await this.git(lane.root, ["status", "--porcelain=v1", "--untracked-files=all"], "WORKTREE_GIT_FAILED", "读取工作树状态失败")).length) throw new AgentError("WORKTREE_DIRTY", "工作树还有未提交的改动，请先让智能体提交");
    if (lines(await this.git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=no"], "WORKTREE_GIT_FAILED", "读取主目录状态失败")).length) throw new AgentError("WORKTREE_MAIN_DIRTY", "主目录有未提交的改动，请先处理后再合并");
    const target = (await this.repository(sourceRoot)).current;
    if (!target) throw new AgentError("WORKTREE_MAIN_DETACHED", "主目录没有检出分支，无法合并");
    const counts = await this.git(sourceRoot, ["rev-list", "--count", `HEAD..${branch}`], "WORKTREE_GIT_FAILED", "读取提交失败");
    if (Number(counts.trim()) === 0) throw new AgentError("WORKTREE_NOTHING_TO_MERGE", "没有需要合并的新提交");
    const preview = await this.run(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", branch], sourceRoot);
    if (preview.code === 1) {
      const conflicts = lines(preview.stdout).slice(1, 51);
      throw new AgentError("WORKTREE_CONFLICT", `与 ${target} 存在冲突：${conflicts.join("、") || "请在工作树中先变基"}`);
    }
    if (preview.code !== 0) throw failure("WORKTREE_GIT_FAILED", "无法核验合并结果", preview.stderr || preview.stdout);
    const identity = (await this.run(["config", "user.email"], sourceRoot)).code === 0 ? {} : {
      GIT_AUTHOR_NAME: "AgentFleets", GIT_AUTHOR_EMAIL: "agentfleets@localhost", GIT_COMMITTER_NAME: "AgentFleets", GIT_COMMITTER_EMAIL: "agentfleets@localhost" };
    const merged = await this.run(["merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${target} (AgentFleets)`, branch], sourceRoot, { env: identity, timeoutMs: 120_000 });
    if (merged.code !== 0) {
      await this.run(["merge", "--abort"], sourceRoot);
      throw failure("WORKTREE_MERGE_FAILED", "合并失败，已撤销", merged.stderr || merged.stdout);
    }
    const commit = (await this.git(sourceRoot, ["rev-parse", "--short", "HEAD"], "WORKTREE_GIT_FAILED", "读取合并结果失败")).trim();
    return { merged: true, target, commit, branch };
  }

  async remove(lane: ProjectRecord, options: { deleteBranch: boolean; force: boolean }) {
    const { sourceRoot, branch } = lane.worktree!;
    const exists = await access(lane.root).then(() => true, () => false);
    if (exists) {
      await this.verifyLane(lane);
      if (!options.force && lines(await this.git(lane.root, ["status", "--porcelain=v1", "--untracked-files=all"], "WORKTREE_GIT_FAILED", "读取工作树状态失败")).length) {
        throw new AgentError("WORKTREE_DIRTY", "工作树还有未提交的改动；确认放弃这些改动后才能删除");
      }
      await this.git(sourceRoot, ["worktree", "remove", ...(options.force ? ["--force"] : []), lane.root], "WORKTREE_REMOVE_FAILED", "删除工作树失败", 120_000);
    } else await this.run(["worktree", "prune"], sourceRoot);
    let branchDeleted = false; let branchKept: string | undefined;
    if (options.deleteBranch) {
      const merged = await this.run(["merge-base", "--is-ancestor", branch, "HEAD"], sourceRoot);
      const deleted = merged.code === 0 ? await this.run(["branch", "-d", branch], sourceRoot) : undefined;
      branchDeleted = deleted?.code === 0;
      if (!branchDeleted) branchKept = "分支尚未合并，已保留";
    }
    return { removed: true, branch, branchDeleted, ...(branchKept ? { branchKept } : {}) };
  }
}

export const worktrees = new Worktrees();

export function parseWorktreeRequest(value: unknown) {
  if (!isRecord(value)) throw new AgentError("WORKTREE_REQUEST_INVALID", "工作树请求无效");
  const text = (key: string, max: number) => value[key] === undefined ? undefined : typeof value[key] === "string" && (value[key] as string).length <= max ? value[key] as string : (() => { throw new AgentError("WORKTREE_REQUEST_INVALID", `工作树请求字段 ${key} 无效`); })();
  return {
    projectExternalId: text("projectExternalId", 256), name: text("name", 48), branch: text("branch", 200), base: text("base", 200), adoptPath: text("adoptPath", 4096),
    forkNativeThreadId: text("forkNativeThreadId", 256), alias: text("alias", 64), provider: text("provider", 32), setup: value.setup === true, deleteBranch: value.deleteBranch === true, force: value.force === true,
  };
}
