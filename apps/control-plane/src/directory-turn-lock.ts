import { posix, win32 } from "node:path";
import type { ControlPlaneDatabase } from "./db.js";

/** Agent reports realpath as canonical_root. Never merge distinct worktrees by repo_root. */
export function directoryProjectIds(db: ControlPlaneDatabase, projectId: string): string[] {
  const target = db.get<{ machine_id: string; canonical_root: string; platform: string }>(
    `SELECT p.machine_id,p.canonical_root,m.platform FROM projects p JOIN machines m USING(machine_id) WHERE p.project_id=?`, projectId);
  if (!target) return [projectId];
  const windows = ["win32", "windows"].includes(target.platform);
  const normalize = (root: string) => windows
    ? win32.normalize(root).replace(/[\\/]+$/u, "").toLowerCase()
    : posix.normalize(root).replace(/\/+$/u, "");
  const root = normalize(target.canonical_root);
  return db.all<{ project_id: string; canonical_root: string }>(
    "SELECT project_id,canonical_root FROM projects WHERE machine_id=?", target.machine_id)
    .filter(project => normalize(project.canonical_root) === root).map(project => project.project_id);
}

/** Called within the same BEGIN IMMEDIATE transaction that inserts a reservation. */
export function directoryTurnConflict(db: ControlPlaneDatabase, projectId: string, sessionId: string,
  allowOwnVoice = false): { project_id: string; logical_session_id: string; state: string; [key: string]: unknown } | undefined {
  const ids = directoryProjectIds(db, projectId);
  const placeholders = ids.map(() => "?").join(",");
  const reservation = db.get<{ project_id: string; logical_session_id: string; state: string; [key: string]: unknown }>(
    `SELECT * FROM project_turn_reservations WHERE project_id IN (${placeholders}) LIMIT 1`, ...ids);
  if (reservation) return reservation;
  // External native work may have no panel reservation. Missing discovery entries
  // are also marked unknown, but an unreachable, unmanaged history entry without
  // an active turn is not evidence of a directory writer. Keep managed uncertainty
  // and every active turn protected; reservations above remain authoritative.
  const running = db.get<{ project_id: string; logical_session_id: string; state: string }>(
    `SELECT project_id,logical_session_id,execution_state AS state FROM logical_sessions
     WHERE project_id IN (${placeholders}) AND logical_session_id<>?
       AND (active_turn_id IS NOT NULL OR execution_state IN ('running','awaiting_approval')
         OR (execution_state='unknown' AND (managed=1 OR reachability<>'unreachable'))) LIMIT 1`, ...ids, sessionId);
  if (running) return running;
  return db.get<{ project_id: string; logical_session_id: string; state: string }>(
    `SELECT project_id,logical_session_id,state FROM voice_sessions WHERE project_id IN (${placeholders}) AND state<>'closed'
     AND NOT (?=1 AND logical_session_id=? AND state='active') LIMIT 1`, ...ids, allowOwnVoice ? 1 : 0, sessionId);
}
