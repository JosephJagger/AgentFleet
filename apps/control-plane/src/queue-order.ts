import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

/** Reorder waiting entries only, using the same version fence as enqueue. */
export function reorderQueue(db: ControlPlaneDatabase, principal: Principal, sessionId: string, value: Record<string, unknown>) {
  invariant(Object.keys(value).every(k => ["queueVersion", "ids"].includes(k)) && Number.isSafeInteger(value.queueVersion) && Array.isArray(value.ids) && value.ids.length <= 100 && value.ids.every(id => typeof id === "string" && id.length <= 200), 400, "INVALID_QUEUE_ORDER", "Invalid queue order");
  const ids = value.ids as string[];
  return db.transaction(() => {
    const session = db.get<{ queue_version: number }>("SELECT queue_version FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?", sessionId, principal.workspaceId);
    invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    invariant(session.queue_version === value.queueVersion, 409, "QUEUE_VERSION_CONFLICT", "队列已变化，请刷新后重新排序");
    const rows = db.all<{ queue_item_id: string; position: number }>("SELECT queue_item_id,position FROM turn_queue WHERE logical_session_id=? AND state='queued' ORDER BY position", sessionId);
    invariant(ids.length === rows.length && new Set(ids).size === ids.length && ids.every(id => rows.some(row => row.queue_item_id === id)), 409, "QUEUE_VERSION_CONFLICT", "等待任务已变化，请刷新后重新排序");
    const max = db.get<{ n: number }>("SELECT COALESCE(MAX(position),0) AS n FROM turn_queue WHERE logical_session_id=?", sessionId)!.n;
    const timestamp = nowIso();
    // Temporary positions avoid the unique session/position constraint.
    ids.forEach((id, i) => db.run("UPDATE turn_queue SET position=?,updated_at=? WHERE queue_item_id=?", max + i + 1, timestamp, id));
    ids.forEach((id, i) => db.run("UPDATE turn_queue SET position=? WHERE queue_item_id=?", rows[i]!.position, id));
    db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, sessionId);
    db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, logicalSessionId: sessionId, action: "turn_queue.reorder", metadata: { ids } });
    return { queueVersion: session.queue_version + 1 };
  });
}
