import type { ControlPlaneDatabase } from './db.js';
import type { Principal } from './auth.js';
import type { ListOptions } from './pagination.js';
import { pageLimit } from './pagination.js';
import { invariant } from './errors.js';
import type { ProjectSummary } from './api-schema.js';

interface CatalogRow {
  project_id: string; machine_id: string; provider: NonNullable<ProjectSummary['provider']>; alias: string;
  canonical_root: string; identity_hash: string; repo_root: string | null;
  worktree_base: string | null; branch: string | null; dirty: number | null;
  lease_version: number; last_reported_at: string; sync_content: number;
  retention_days: ProjectSummary['retentionDays']; family_id: string;
  running: number; waiting: number; uncertain: number;
}

/** Page repository families, never split a main directory from its worktrees. */
export function projectCatalog(db: ControlPlaneDatabase, principal: Principal, options: ListOptions, includeProjectId?: string) {
  invariant(!options.cursor && !options.q, 400, 'INVALID_PAGINATION', 'Grouped projects use offset pagination without search');
  const params: (string | number)[] = [principal.workspaceId];
  const where = ["p.workspace_id=?", "m.identity_state='active'", 'p.worktree_removed=0'];
  if (options.machineId) { where.push('p.machine_id=?'); params.push(options.machineId); }
  if (options.provider) { where.push('p.provider=?'); params.push(options.provider); }
  const cte = `WITH catalog AS (SELECT p.*, COALESCE((SELECT root.project_id FROM projects root
    WHERE root.workspace_id=p.workspace_id AND root.machine_id=p.machine_id AND root.provider=p.provider
      AND root.canonical_root=p.repo_root AND p.repo_root<>p.canonical_root AND root.worktree_removed=0
      AND (root.repo_root IS NULL OR root.repo_root=root.canonical_root)
    ORDER BY root.project_id LIMIT 1),p.project_id) AS family_id
    FROM projects p JOIN machines m ON m.machine_id=p.machine_id WHERE ${where.join(' AND ')})`;
  const total = db.get<{n:number}>(`${cte} SELECT count(DISTINCT family_id) AS n FROM catalog`, ...params)!.n;
  const families = db.all<{family_id:string}>(`${cte} SELECT DISTINCT c.family_id, root.alias FROM catalog c JOIN catalog root ON root.project_id=c.family_id ORDER BY root.alias,c.family_id LIMIT ? OFFSET ?`, ...params, pageLimit(options.limit), options.offset ?? 0).map(r=>r.family_id);
  if (includeProjectId) {
    const selected = db.get<{family_id:string}>(`${cte} SELECT family_id FROM catalog WHERE project_id=?`, ...params, includeProjectId);
    if (selected && !families.includes(selected.family_id)) families.unshift(selected.family_id);
  }
  if (!families.length) return { items: [], nextCursor: null, total };
  const rows = db.all<CatalogRow>(`${cte} SELECT c.*,
    (SELECT count(*) FROM logical_sessions s WHERE s.project_id=c.project_id AND s.workspace_id=c.workspace_id AND s.deleted_at IS NULL AND s.execution_state='running') AS running,
    (SELECT count(*) FROM logical_sessions s WHERE s.project_id=c.project_id AND s.workspace_id=c.workspace_id AND s.deleted_at IS NULL AND s.execution_state='awaiting_approval') AS waiting,
    (SELECT count(*) FROM logical_sessions s WHERE s.project_id=c.project_id AND s.workspace_id=c.workspace_id AND s.deleted_at IS NULL AND s.execution_state='unknown') AS uncertain
    FROM catalog c WHERE c.family_id IN (${families.map(()=>'?').join(',')}) ORDER BY c.alias,c.project_id`, ...params, ...families);
  const items = rows.map(row => ({ projectId: row.project_id, machineId: row.machine_id, provider: row.provider, alias: row.alias, canonicalRoot: row.canonical_root,
    identityHash: row.identity_hash, repoRoot: row.repo_root, worktreeBase: row.worktree_base, branch: row.branch, dirty: row.dirty===null?null:row.dirty===1,
    leaseVersion: row.lease_version, lastReportedAt: row.last_reported_at, syncContent: row.sync_content===1, retentionDays: row.retention_days,
    parentProjectId: row.family_id === row.project_id ? null : row.family_id,
    activity: { running: row.running, waiting: row.waiting, uncertain: row.uncertain },
  } satisfies ProjectSummary & {parentProjectId:string|null;activity:{running:number;waiting:number;uncertain:number}}));
  return { items, nextCursor: null, total };
}
