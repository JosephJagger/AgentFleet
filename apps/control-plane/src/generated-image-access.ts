import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";

/** Recheck the durable owner, retention, content epoch and project policy on every chunk. */
export function generatedImageAccess(db: ControlPlaneDatabase, principal: Principal, sessionId: string, eventId: string) {
  const row = db.get<{native_thread_id:string;native_item_id:string;body_json:string}>(`SELECT e.native_thread_id,e.native_item_id,b.body_json
    FROM durable_events e JOIN logical_sessions s ON s.logical_session_id=e.logical_session_id
    JOIN projects p ON p.project_id=s.project_id JOIN content_blobs b ON b.payload_ref=e.payload_ref
    WHERE e.event_id=? AND e.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL
      AND e.machine_id=s.machine_id AND e.project_id=s.project_id AND e.content_epoch=s.content_epoch
      AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1`,eventId,sessionId,principal.workspaceId,new Date().toISOString());
  invariant(row,404,"GENERATED_IMAGE_UNAVAILABLE","Generated image is unavailable for this Session");
  let item: Record<string,unknown> | undefined;
  try { item=JSON.parse(row.body_json)?.item; } catch { /* invalid retained payload */ }
  invariant(item?.type === "imageGeneration" && item.status === "completed" && item.imageState === "streamed" && item.id === row.native_item_id
    && /^[A-Za-z0-9_-]{1,128}$/.test(row.native_thread_id) && typeof row.native_item_id === "string" && row.native_item_id.length <= 256,
    404,"GENERATED_IMAGE_UNAVAILABLE","Generated image is unavailable for this Session");
  return {nativeThreadId:row.native_thread_id,itemId:row.native_item_id};
}
