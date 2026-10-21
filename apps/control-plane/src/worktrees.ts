import { randomUUID } from "node:crypto";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { directoryTurnConflict } from "./directory-turn-lock.js";
import { AppError, invariant } from "./errors.js";
import { isProviderId, type ProviderId } from "./provider-catalog.js";

/**
 * Git worktree lanes. A lane is a project whose host reported repo_root (its main repository) and branch. Each
 * lane is its own directory, so the existing per-directory turn lock lets agents run in different lanes at once.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const externalId = (value: unknown) => { invariant(typeof value === "string" && value.length > 0 && value.length <= 256, 400, "WORKTREE_REQUEST_INVALID", "缺少项目"); return value; };

/** Shape of the operation target the host receives; built by the server from trusted project rows. */
export function parseWorktreeTarget(type: string, value: unknown): Record<string, unknown> {
  const raw = object(value);
  invariant(["worktree.create", "worktree.merge", "worktree.remove"].includes(type), 400, "INVALID_OPERATION", "Unsupported worktree operation");
  if (type === "worktree.create") {
    invariant(isProviderId(raw.provider), 400, "INVALID_PROVIDER", "Unknown agent provider");
    invariant(typeof raw.alias === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.alias), 400, "WORKTREE_REQUEST_INVALID", "项目名称无效");
    invariant(raw.name === undefined || typeof raw.name === "string" && NAME.test(raw.name), 400, "WORKTREE_NAME_INVALID", "工作树名称仅支持小写字母、数字、点、下划线和连字符，最长 48 位");
    invariant(raw.base === undefined || typeof raw.base === "string" && BRANCH.test(raw.base) && !raw.base.includes(".."), 400, "WORKTREE_BASE_INVALID", "基础分支无效");
    invariant(raw.adoptPath === undefined || typeof raw.adoptPath === "string" && raw.adoptPath.startsWith("/") && raw.adoptPath.length <= 4096, 400, "WORKTREE_PATH_INVALID", "工作树路径无效");
    invariant(Boolean(raw.name) !== Boolean(raw.adoptPath), 400, "WORKTREE_REQUEST_INVALID", "请填写工作树名称，或选择已有工作树");
    return { projectExternalId: externalId(raw.projectExternalId), provider: raw.provider, alias: raw.alias, ...(raw.name ? { name: raw.name } : {}),
      ...(raw.base ? { base: raw.base } : {}), ...(raw.adoptPath ? { adoptPath: raw.adoptPath } : {}), setup: raw.setup === true };
  }
  if (type === "worktree.merge") return { projectExternalId: externalId(raw.projectExternalId) };
  return { projectExternalId: externalId(raw.projectExternalId), deleteBranch: raw.deleteBranch === true, force: raw.force === true };
}

interface ProjectRow { project_id: string; machine_id: string; external_id: string; alias: string; canonical_root: string; provider: ProviderId; repo_root: string | null; branch: string | null; worktree_base: string | null; worktree_removed: number }
interface SessionRow { logical_session_id: string; project_id: string; title: string; execution_state: string; active_turn_id: string | null; updated_at: string }
export interface LaneStatus { path: string; branch: string; base: string; exists: boolean; dirtyFiles: number; ahead: number; behind: number; changedFiles: string[]; lastCommit: string; providers: string[] }

export class WorktreeService {
  constructor(private readonly db: ControlPlaneDatabase) {}

  private project(principal: Principal, projectId: string) {
    const row = this.db.get<ProjectRow>("SELECT * FROM projects WHERE project_id=? AND workspace_id=? AND worktree_removed=0", projectId, principal.workspaceId);
    invariant(row, 404, "PROJECT_NOT_FOUND", "项目不存在");
    return row;
  }

  /** The main repository project for a project or one of its lanes; prefers the same agent's registration. */
  main(principal: Principal, projectId: string): ProjectRow {
    const project = this.project(principal, projectId);
    if (!project.repo_root || project.repo_root === project.canonical_root) return project;
    const parents = this.db.all<ProjectRow>("SELECT * FROM projects WHERE machine_id=? AND canonical_root=? AND (repo_root IS NULL OR repo_root=canonical_root) AND worktree_removed=0 ORDER BY provider='codex' DESC,project_id", project.machine_id, project.repo_root);
    const parent = parents.find(row => row.provider === project.provider) ?? parents[0];
    invariant(parent, 404, "WORKTREE_SOURCE_MISSING", "工作树的主仓库项目不存在，请先在面板添加主仓库");
    return parent;
  }

  lane(principal: Principal, projectId: string): ProjectRow {
    const lane = this.project(principal, projectId);
    invariant(lane.repo_root && lane.repo_root !== lane.canonical_root && lane.branch, 400, "WORKTREE_NOT_LANE", "该项目不是工作树");
    return lane;
  }

  /** Lanes grouped by directory, with every agent registered there and its sessions. */
  lanes(main: ProjectRow) {
    const rows = this.db.all<ProjectRow>("SELECT * FROM projects WHERE machine_id=? AND repo_root=? AND canonical_root<>repo_root AND worktree_removed=0 ORDER BY canonical_root,provider", main.machine_id, main.canonical_root);
    const ids = rows.map(row => row.project_id);
    const sessions = ids.length ? this.db.all<SessionRow>(
      `SELECT logical_session_id,project_id,title,execution_state,active_turn_id,updated_at FROM logical_sessions
       WHERE project_id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200`, ...ids) : [];
    const grouped = new Map<string, { path: string; branch: string; base: string; projects: { projectId: string; provider: ProviderId; alias: string }[]; sessions: Record<string, unknown>[] }>();
    for (const row of rows) {
      const lane = grouped.get(row.canonical_root) ?? { path: row.canonical_root, branch: row.branch ?? "", base: row.worktree_base ?? "", projects: [], sessions: [] };
      lane.projects.push({ projectId: row.project_id, provider: row.provider, alias: row.alias });
      for (const session of sessions.filter(item => item.project_id === row.project_id).slice(0, 20)) lane.sessions.push({
        id: session.logical_session_id, projectId: row.project_id, provider: row.provider, title: session.title,
        executionState: session.execution_state, running: session.active_turn_id !== null, updatedAt: session.updated_at });
      grouped.set(row.canonical_root, lane);
    }
    return [...grouped.values()];
  }

  /** Combine the host's git view with panel projects and sessions. */
  overview(principal: Principal, projectId: string, host: unknown) {
    const main = this.main(principal, projectId);
    const raw = object(host);
    const statuses = new Map((Array.isArray(raw.lanes) ? raw.lanes : []).map(object).filter(lane => typeof lane.path === "string").map(lane => [lane.path as string, lane]));
    const list = (value: unknown, max: number) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 4096).slice(0, max) : [];
    const number = (value: unknown) => Number.isSafeInteger(value) ? Number(value) : 0;
    return {
      project: { projectId: main.project_id, alias: main.alias, root: main.canonical_root, provider: main.provider, machineId: main.machine_id },
      current: typeof raw.current === "string" ? raw.current : null,
      branches: list(raw.branches, 200), mainDirtyFiles: number(raw.mainDirtyFiles), setupScript: raw.setupScript === true,
      lanes: this.lanes(main).map(lane => {
        const status = statuses.get(lane.path) ?? {};
        return { ...lane, exists: status.exists !== false, dirtyFiles: number(status.dirtyFiles), ahead: number(status.ahead), behind: number(status.behind),
          changedFiles: list(status.changedFiles, 300), lastCommit: typeof status.lastCommit === "string" ? status.lastCommit.slice(0, 200) : "" };
      }),
      overlaps: (Array.isArray(raw.overlaps) ? raw.overlaps : []).map(object).filter(item => typeof item.file === "string").slice(0, 100)
        .map(item => ({ file: String(item.file).slice(0, 4096), branches: list(item.branches, 20) })),
      unmanaged: (Array.isArray(raw.unmanaged) ? raw.unmanaged : []).map(object).filter(item => typeof item.path === "string").slice(0, 50)
        .map(item => ({ path: String(item.path), branch: typeof item.branch === "string" ? item.branch : null })),
    };
  }

  createTarget(principal: Principal, projectId: string, body: Record<string, unknown>) {
    const main = this.main(principal, projectId);
    invariant(isProviderId(body.provider), 400, "INVALID_PROVIDER", "Unknown agent provider");
    const adoptPath = typeof body.adoptPath === "string" && body.adoptPath ? body.adoptPath : undefined;
    const name = adoptPath ? undefined : typeof body.name === "string" && body.name ? body.name : `${body.provider}-${randomUUID().slice(0, 6)}`;
    const leaf = (name ?? adoptPath!.split("/").filter(Boolean).at(-1) ?? "lane").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
    const alias = `${main.alias}-${leaf}`.slice(0, 64).replace(/[^A-Za-z0-9]+$/, "") || "worktree";
    const target = parseWorktreeTarget("worktree.create", { projectExternalId: main.external_id, provider: body.provider, alias,
      ...(name ? { name } : {}), ...(typeof body.base === "string" && body.base ? { base: body.base } : {}), ...(adoptPath ? { adoptPath } : {}), setup: body.setup === true });
    return { machineId: main.machine_id, target };
  }

  /** Merging writes the main directory and removal deletes the lane: both wait for turns there to finish. */
  laneTarget(principal: Principal, projectId: string, type: "worktree.merge" | "worktree.remove", body: Record<string, unknown>) {
    const lane = this.lane(principal, projectId);
    const guarded = [lane, ...(type === "worktree.merge" ? [this.main(principal, projectId)] : [])];
    for (const project of guarded) {
      const conflict = directoryTurnConflict(this.db, project.project_id, "");
      if (conflict) throw new AppError(409, "WORKTREE_BUSY", project === lane ? "工作树中仍有任务在运行，请等待完成后再操作" : "主目录中仍有任务在运行，请等待完成后再合并");
    }
    return { machineId: lane.machine_id, target: parseWorktreeTarget(type, { projectExternalId: lane.external_id, deleteBranch: body.deleteBranch === true, force: body.force === true }) };
  }
}
