import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { validGeneratedImageUrl } from "./images.js";

/** Authorize even conditional requests: a cached image must not bypass cleanup or access changes. */
export function readEventImage(db: ControlPlaneDatabase, principal: Principal, sessionId: string, eventId: string, hash: string, ifNoneMatch = "") {
  invariant(/^[a-f0-9]{64}$/.test(hash), 404, "IMAGE_UNAVAILABLE", "Image is unavailable");
  const etag = `"sha256-${hash}"`;
  const matches = ifNoneMatch.split(",").map(value => value.trim().replace(/^W\//, ""));
  const notModified = matches.includes(etag) || matches.includes("*");
  // Revalidate ownership without moving the full image from the database on a cache hit.
  const row = db.get<{ data_url: string }>(`SELECT ${notModified ? "substr(i.data_url,1,32)" : "i.data_url"} AS data_url
    FROM durable_events e JOIN logical_sessions s ON s.logical_session_id=e.logical_session_id
    JOIN projects p ON p.project_id=s.project_id JOIN content_blobs b ON b.payload_ref=e.payload_ref
    JOIN cloud_image_refs r ON r.owner_type='event' AND r.owner_id=e.payload_ref AND r.machine_id=e.machine_id
    JOIN cloud_images i ON i.machine_id=r.machine_id AND i.image_hash=r.image_hash
    WHERE e.event_id=? AND e.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL
      AND e.machine_id=s.machine_id AND e.project_id=s.project_id AND e.workspace_id=s.workspace_id
      AND b.workspace_id=s.workspace_id AND p.workspace_id=s.workspace_id
      AND e.content_epoch=s.content_epoch AND e.projection_epoch=s.projection_epoch
      AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1
      AND i.image_hash=? AND i.data_url IS NOT NULL AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM image_cleaned_turns t WHERE t.machine_id=e.machine_id
        AND t.logical_session_id=e.logical_session_id AND t.native_thread_id=e.native_thread_id
        AND t.native_turn_id=e.native_turn_id AND t.image_hash=i.image_hash)`,
    eventId, sessionId, principal.workspaceId, new Date().toISOString(), hash);
  invariant(row && (notModified ? /^data:image\/(png|jpeg|webp);base64,/.test(row.data_url) : validGeneratedImageUrl(row.data_url)), 404, "IMAGE_UNAVAILABLE", "Image is unavailable");
  const comma = row.data_url.indexOf(",");
  const mime = row.data_url.slice(5, row.data_url.indexOf(";"));
  return { etag, mime, bytes: notModified ? undefined : Buffer.from(row.data_url.slice(comma + 1), "base64") };
}
