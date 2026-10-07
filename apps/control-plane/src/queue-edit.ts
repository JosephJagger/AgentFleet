import type { ControlPlaneDatabase } from "./db.js";
import type { CoordinationService } from "./coordination.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

/** Replace a waiting command atomically; accepted command payloads and hashes remain immutable. */
export function editQueuedPrompt(db: ControlPlaneDatabase, coordination: CoordinationService, principal: Principal, sessionId: string, itemId: string, input: Record<string, unknown>) {
  invariant(Object.keys(input).every(k => ["prompt", "queueVersion", "clientMutationId"].includes(k)) && typeof input.prompt === "string" && input.prompt.trim().length > 0 && Buffer.byteLength(input.prompt) <= 200_000 && Number.isSafeInteger(input.queueVersion) && typeof input.clientMutationId === "string" && input.clientMutationId.length >= 8 && input.clientMutationId.length <= 200, 400, "INVALID_QUEUE_EDIT", "Invalid queued message");
  return db.transaction(() => {
    const row = db.get<{ command_id: string; state: string; position: number; expires_at: string; queue_version: number; execution_segment_id: string; thread_control_version: number; active_turn_id: string | null; project_lease_version: number }>(`SELECT q.command_id,q.state,q.position,q.expires_at,s.queue_version,e.execution_segment_id,s.thread_control_version,s.active_turn_id,p.lease_version AS project_lease_version FROM turn_queue q JOIN logical_sessions s ON s.logical_session_id=q.logical_session_id JOIN projects p ON p.project_id=s.project_id JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL WHERE q.queue_item_id=? AND q.logical_session_id=? AND q.workspace_id=?`,itemId,sessionId,principal.workspaceId);
    invariant(row,404,"QUEUE_ITEM_NOT_FOUND","Queued turn was not found");
    const previous = db.get<{ detail_json: string }>("SELECT detail_json FROM command_lifecycle WHERE command_id=? AND state='invalidated' ORDER BY rowid DESC LIMIT 1",row.command_id);
    const replacement = previous?.detail_json ? JSON.parse(previous.detail_json) as Record<string,unknown> : null;
    if (replacement && replacement.clientMutationId === input.clientMutationId && typeof replacement.replacementCommandId === "string") {
      const command = coordination.getCommand(principal,replacement.replacementCommandId);
      invariant((command.payload as Record<string,unknown>)?.prompt === input.prompt,409,"IDEMPOTENCY_KEY_REUSE","Message changed after submission");
      return {commandId:replacement.replacementCommandId,duplicate:true};
    }
    invariant(row.state === "queued" && row.queue_version === input.queueVersion,409,"QUEUE_VERSION_CONFLICT","任务或队列已变化，请刷新后重新编辑");
    const remaining = Math.floor((Date.parse(row.expires_at)-Date.now())/1000);
    invariant(remaining > 0,409,"QUEUE_EXPIRED","Queued turn has expired");
    const original = coordination.getCommand(principal,row.command_id);
    invariant(original.payload && typeof original.payload === "object",409,"QUEUE_CONTENT_UNAVAILABLE","Queued message is no longer available");
    const payload: Record<string,unknown> = {...original.payload as Record<string,unknown>,prompt:input.prompt};
    for (const key of ["resolvedMode","permissionProfile","permissionSource","sessionTitle"]) delete payload[key];
    const created = coordination.createCommand(principal,sessionId,{type:"turn.queue",clientMutationId:input.clientMutationId as string,payload,expiresInSeconds:Math.min(remaining,86400),precondition:{executionSegmentId:row.execution_segment_id,threadControlVersion:row.thread_control_version,expectedActiveTurnId:row.active_turn_id,projectLeaseVersion:row.project_lease_version,queueVersion:row.queue_version}},true);
    invariant(!created.duplicate,409,"IDEMPOTENCY_KEY_REUSE","Mutation already belongs to another queued message");
    const commandId=String(created.command.commandId);
    const next=db.get<{position:number;queue_item_id:string}>("SELECT position,queue_item_id FROM turn_queue WHERE command_id=?",commandId)!;
    const timestamp=nowIso();
    db.run("UPDATE turn_queue SET state='cancelled',position=?,updated_at=? WHERE queue_item_id=?",next.position+1,timestamp,itemId);
    db.run("UPDATE turn_queue SET position=? WHERE queue_item_id=?",row.position,next.queue_item_id);
    db.run("UPDATE command_projection SET state='invalidated',updated_at=? WHERE command_id=?",timestamp,row.command_id);
    db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)",row.command_id,JSON.stringify({reason:"queue_edited",replacementCommandId:commandId,clientMutationId:input.clientMutationId}),timestamp);
    db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,actorClientSessionId:principal.clientSessionId,logicalSessionId:sessionId,action:"turn_queue.edit",metadata:{queueItemId:itemId,replacementCommandId:commandId}});
    return {commandId,duplicate:false};
  });
}
