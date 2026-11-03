import {recoveryCommands} from "./session-recovery-state.js";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { canonicalJson, nowIso, sha256 } from "./crypto.js";
import { invariant } from "./errors.js";
import { MaintenanceService } from "./maintenance.js";
import { sameLeaseAccount } from "./lease-ownership.js";

/** User-directed dismissal of an obsolete runtime's pending state, not proof of task completion.
 * Dispatches an authenticated host recovery request. No prompt is sent; the host
 * checks native activity and resets its own durable state before acknowledging.
 */
export class SessionRecoveryService {
  constructor(private readonly db: ControlPlaneDatabase) {}

  inspect(principal: Principal, sessionId: string) {
    const s = this.db.get<{
      project_id: string; machine_id: string; execution_state: string; active_turn_id: string | null;
      content_epoch: number; turn_control_version: number; managed: number; reachability: string;
      discovery_json: string | null; machine_reachability: string; identity_state: string; execution_segment_id: string; native_thread_id: string | null;
    }>(`SELECT s.*,m.reachability AS machine_reachability,m.identity_state,m.discovery_json,e.execution_segment_id,e.native_thread_id
       FROM logical_sessions s JOIN machines m USING(machine_id)
       JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
       WHERE s.logical_session_id=? AND s.workspace_id=?`, sessionId, principal.workspaceId);
    invariant(s, 404, "SESSION_NOT_FOUND", "Session was not found");
    const blocked = (reasonCode: string, reason: string) => ({ canRetry: false, token: null, reasonCode, reason });
    if (s.identity_state !== "active" || s.machine_reachability !== "online" || s.reachability !== "live")
      return blocked("MACHINE_OFFLINE", "等待主机重新连接后重试恢复");
    const discovery=JSON.parse(s.discovery_json ?? "{}");
    const retry=discovery.sessionRecoveryRetry===true;
    if (!retry && discovery.sessionRecoveryDismiss !== true) return blocked("RECOVERY_UPDATE_REQUIRED", "请更新主机连接服务后使用重试恢复");
    if (!retry && (!s.managed || !s.native_thread_id)) return blocked("THREAD_NOT_AVAILABLE", "请先连接原会话");
    const r = this.db.get<{ logical_session_id: string; native_turn_id: string | null; bound_app_server_epoch: string | null;
      binding_state: string; version: number; state: string; command_id: string | null }>(
      "SELECT * FROM project_turn_reservations WHERE project_id=?", s.project_id);
    const connection = this.db.get<{ app_server_epoch: string | null; transport_generation: number }>(
      "SELECT app_server_epoch,transport_generation FROM agent_connections WHERE machine_id=? AND disconnected_at IS NULL ORDER BY transport_generation DESC LIMIT 1", s.machine_id);
    const commands=recoveryCommands(this.db,sessionId);
    if(r && r.logical_session_id!==sessionId) return {...blocked("RECOVERY_OTHER_SESSION","同一目录的另一个会话需要恢复，请先打开该会话"),recoverySessionId:r.logical_session_id};
    if(!connection?.app_server_epoch)return blocked("MACHINE_RECONNECTING","等待主机重新连接后重试恢复");
    if(!r && !commands.length && !s.active_turn_id && s.execution_state!=="unknown")return blocked("RECOVERY_NOT_NEEDED","会话已无挂起锁定，请刷新后继续");
    if(!retry){
      if (!r || r.binding_state !== "bound" || !r.native_turn_id || !r.bound_app_server_epoch || r.state === "migration_conflict")
        return blocked("RECOVERY_UPDATE_REQUIRED", "请更新主机连接服务后使用重试恢复");
      if (r.bound_app_server_epoch === connection.app_server_epoch || s.active_turn_id !== null || ["running", "awaiting_approval"].includes(s.execution_state) || commands.length)
        return blocked("RECOVERY_UPDATE_REQUIRED", "请更新主机连接服务后使用重试恢复");
    }
    if (this.db.get("SELECT 1 FROM voice_sessions WHERE logical_session_id=? AND state<>'closed' LIMIT 1", sessionId))
      return blocked("RECOVERY_VOICE_ACTIVE", "请先结束此会话的语音通话");
    const lease = this.db.get<{ holder_client_session_id: string }>(
      "SELECT holder_client_session_id FROM control_leases WHERE logical_session_id=? AND state='active' AND expires_at>?", sessionId, nowIso());
    if (lease && !sameLeaseAccount(this.db, lease.holder_client_session_id, principal.clientSessionId))
      return blocked("CONTROL_HELD_ELSEWHERE", "另一个账号正在操作此会话");
    const lastFailure=this.db.get<{operation_id:string}>(`SELECT operation_id FROM machine_operations WHERE machine_id=? AND type='session.reconcile'
      AND json_extract(request_json,'$.logicalSessionId')=? AND (state IN ('failed','expired','unknown') OR (state='succeeded' AND COALESCE(CAST(json_extract(result_json,'$.recovered') AS TEXT),'false') IN ('0','false'))) ORDER BY created_at DESC LIMIT 1`,s.machine_id,sessionId);
    const token = sha256(canonicalJson({ mode:retry?'retry':'dismiss',failedOperation:lastFailure?.operation_id??null,commands,executionState:s.execution_state,activeTurnId:s.active_turn_id,sessionId, workspaceId: principal.workspaceId, projectId: s.project_id,
      contentEpoch: s.content_epoch, turnControlVersion: s.turn_control_version, segmentId: s.execution_segment_id,
      nativeThreadId: s.native_thread_id, reservation: r ?? null, connection }));
    return { canRetry: true, token, reasonCode: null, reason: null };
  }

  dismiss(principal: Principal, sessionId: string, token: unknown) {
    invariant(typeof token === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(token), 400, "RECOVERY_TOKEN_REQUIRED", "请重新检查会话状态");
    const identity = this.db.get<{machine_id:string}>("SELECT machine_id FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?",sessionId,principal.workspaceId);
    invariant(identity,404,"SESSION_NOT_FOUND","Session was not found");
    const maintenance = new MaintenanceService(this.db);
    const discovery=this.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id=?",identity.machine_id);
    const mode=JSON.parse(discovery?.discovery_json??"{}").sessionRecoveryRetry===true?"retry":"dismiss";
    const operation = maintenance.create(principal, identity.machine_id, "session.reconcile", `retry-${token}`, sessionId, undefined, undefined, { mode, ...(mode==="retry"?{token}:{}) }, () => {
      const preview = this.inspect(principal, sessionId);
      invariant(preview.canRetry, 409, preview.reasonCode ?? "RECOVERY_UNAVAILABLE", preview.reason ?? "暂时无法恢复");
      invariant(preview.token === token, 409, "RECOVERY_TARGET_CHANGED", "会话状态已变化，请重新点击重试恢复");
      const s = this.db.get<{ project_id: string; machine_id: string }>("SELECT project_id,machine_id FROM logical_sessions WHERE logical_session_id=?", sessionId)!;
      const r = this.db.get<{ native_turn_id: string; bound_app_server_epoch: string; version: number }>("SELECT * FROM project_turn_reservations WHERE project_id=?", s.project_id)!;
      const timestamp = nowIso();
      // Do not let releasing the old reservation implicitly dispatch queued prompts.
      // Their content remains in command_contents and the existing command history.
      const queue = this.db.all<{ queue_item_id: string; command_id: string }>("SELECT queue_item_id,command_id FROM turn_queue WHERE logical_session_id=? AND state='queued'", sessionId);
      for (const item of queue) {
        this.db.run("UPDATE turn_queue SET state='cancelled',updated_at=? WHERE queue_item_id=?", timestamp, item.queue_item_id);
        this.db.run("UPDATE command_projection SET state='invalidated',updated_at=? WHERE command_id=?", timestamp, item.command_id);
        this.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)", item.command_id, canonicalJson({ reason: "session_pending_state_dismissed", queueItemId: item.queue_item_id }), timestamp);
      }
      if (queue.length) this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, sessionId);
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId,
        machineId: s.machine_id, projectId: s.project_id, logicalSessionId: sessionId, action: "session.recovery_requested", outcome: "requested",
        metadata: { token, nativeTurnId: r?.native_turn_id??null, previousAppServerEpoch: r?.bound_app_server_epoch??null,
          source: "user_retry", resultKnown: false, commandReplayed: false, cancelledQueueItems: queue.map(item => item.queue_item_id) } });
    });
    return { operation };
  }
}
