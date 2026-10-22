import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import type { ProviderId } from "./provider-catalog.js";

interface GitStatus { cwd: string; root: string; dirty: boolean; checkedAt: string }
export function parseWorkspaceGitStatus(value: unknown): GitStatus[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1000).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.cwd === "string" && row.cwd.length <= 4096 && row.cwd.length > 0
      && typeof row.root === "string" && row.root.length <= 4096 && row.root.length > 0
      && typeof row.dirty === "boolean" && typeof row.checkedAt === "string" && row.checkedAt.length <= 40 && Number.isFinite(Date.parse(row.checkedAt))
      ? [{ cwd: row.cwd, root: row.root, dirty: row.dirty, checkedAt: row.checkedAt }] : [];
  });
}

export interface PendingCommit {
  id: string; logicalSessionId: string; title: string; machineId: string; machineName: string;
  projectAlias: string; path: string; provider: ProviderId; checkedAt: string;
}

/** Directory evidence, not authorship: one recent completed session links each dirty, idle worktree. */
export function pendingCommits(db: ControlPlaneDatabase, principal: Principal, now = Date.now()): PendingCommit[] {
  const machines = db.all<{ machine_id: string; name: string; discovery_json: string | null }>(
    "SELECT machine_id,COALESCE(display_alias,name) AS name,discovery_json FROM machines WHERE workspace_id=? AND identity_state='active' AND reachability='online'", principal.workspaceId);
  const result: PendingCommit[] = [];
  for (const machine of machines) {
    const discovery = JSON.parse(machine.discovery_json ?? "{}") as Record<string, unknown>;
    const statuses = parseWorkspaceGitStatus(discovery.workspaceGitStatus).filter(s => {
      const age = now - Date.parse(s.checkedAt);
      return age >= -5000 && age < 120_000;
    });
    if (!statuses.length) continue;
    const byCwd = new Map(statuses.map(s => [s.cwd, s]));
    const byRoot = new Map<string, GitStatus>();
    for (const status of statuses) if (!byRoot.has(status.root) || status.checkedAt > byRoot.get(status.root)!.checkedAt) byRoot.set(status.root, status);
    const sessions = db.all<{ logical_session_id: string; title: string; provider: ProviderId; alias: string; cwd: string; execution_state: string; active_turn_id: string | null; ended_at: string | null; updated_at: string }>(
      `SELECT s.logical_session_id,s.title,p.provider,p.alias,COALESCE(s.session_cwd,p.canonical_root) AS cwd,
        s.execution_state,s.active_turn_id,s.updated_at,
        (SELECT MAX(e.occurred_at) FROM durable_events e WHERE e.logical_session_id=s.logical_session_id AND e.type IN ('turn.completed','turn.failed','turn.interrupted')) AS ended_at
       FROM logical_sessions s JOIN projects p ON p.project_id=s.project_id
       WHERE s.machine_id=? AND s.workspace_id=? AND s.deleted_at IS NULL AND p.worktree_removed=0
         AND COALESCE(json_extract(s.runtime_settings_json,'$.archived'),0)=0
       ORDER BY COALESCE(ended_at,s.updated_at) DESC,s.logical_session_id`, machine.machine_id, principal.workspaceId);
    const busy = sessions.filter(s => s.active_turn_id || ["running", "awaiting_approval", "unknown"].includes(s.execution_state));
    const seen = new Set<string>();
    for (const session of sessions) {
      const observed = byCwd.get(session.cwd);
      const status = observed ? byRoot.get(observed.root) : undefined;
      if (!status?.dirty || session.execution_state !== "completed" || seen.has(status.root)) continue;
      // Any active provider in this physical working directory suppresses the reminder.
      if (busy.some(s => {
        const root = byCwd.get(s.cwd)?.root;
        return root ? root === status.root : s.cwd === status.root || s.cwd.startsWith(status.root.replace(/[\\/]+$/, "") + (status.root.includes("\\") ? "\\" : "/"));
      })) continue;
      if (session.ended_at && Date.parse(status.checkedAt) < Date.parse(session.ended_at)) continue;
      seen.add(status.root);
      result.push({ id: `${machine.machine_id}:${status.root}`, logicalSessionId: session.logical_session_id,
        title: session.title, provider: session.provider, machineId: machine.machine_id, machineName: machine.name,
        projectAlias: session.alias, path: status.root, checkedAt: status.checkedAt });
    }
  }
  return result;
}
