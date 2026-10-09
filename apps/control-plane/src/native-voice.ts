import { assertVoiceAdmission } from "./voice-deployment.js";
import type { CoordinationService } from "./coordination.js";
import { sameLeaseAccount } from "./lease-ownership.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import type { RegistryService } from "./registry.js";
import { invariant } from "./errors.js";
import { newId, nowIso } from "./crypto.js";

export const VOICE_CONTROL_TTL_SECONDS = 120;

export interface VoiceBinding {
  voiceId: string; logicalSessionId: string; projectId: string; machineId: string;
  executionSegmentId: string; nativeThreadId: string; contentEpoch: number;
  producerEpoch: string; appServerEpoch: string; transportGeneration: number;
}
export interface VoiceRow {
  voice_id: string; logical_session_id: string; project_id: string; machine_id: string;
  closed_through: number | null; owner_id: string; lease_id: string; binding_json: string; state: string; created_at: string; updated_at: string;
}

/** Only metadata is durable. SDP and audio must never enter command/event history. */
export class NativeVoiceService {
  constructor(private db: ControlPlaneDatabase, private registry: RegistryService) {}
  start(principal: Principal, id: string, leaseId: string, connection: Pick<VoiceBinding, "producerEpoch" | "appServerEpoch" | "transportGeneration">): VoiceBinding {
    return this.db.transaction(() => {
      assertVoiceAdmission(this.db);
      const session = this.registry.getSession(principal, id);
      invariant(session.provider !== "claude" && session.managed && session.nativeThreadId && session.reachability === "live" && session.actions.start.allowed, 409, "VOICE_NOT_READY", "请等待主机在线、会话接管完成且项目空闲后开始语音");
      const lease=this.db.get<{holder_client_session_id:string}>("SELECT holder_client_session_id FROM control_leases WHERE control_lease_id=? AND logical_session_id=? AND state='active' AND expires_at>?",leaseId,id,nowIso());
      invariant(lease && sameLeaseAccount(this.db,lease.holder_client_session_id,principal.clientSessionId), 409, "VOICE_CONTROL_REQUIRED", "请重新获取会话控制权");
      invariant(!this.db.get("SELECT 1 FROM voice_sessions WHERE project_id=? AND state<>'closed'", session.projectId), 409, "VOICE_PROJECT_BUSY", "此项目已有语音连接，或正在确认上次连接已结束");
      invariant(!this.db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?",session.projectId) && !this.db.get("SELECT 1 FROM logical_sessions WHERE project_id=? AND active_turn_id IS NOT NULL", session.projectId), 409, "VOICE_PROJECT_BUSY", "请等待项目任务结束后开始语音");
      invariant(!this.db.get("SELECT 1 FROM commands c JOIN command_projection cp USING(command_id) JOIN logical_sessions s USING(logical_session_id) WHERE s.machine_id=? AND cp.state IN ('accepted','dispatching','unknown')", session.machineId), 409, "VOICE_PENDING_COMMAND", "请等待已提交的主机操作确认后开始语音");
      invariant(!this.db.get("SELECT 1 FROM turn_queue q JOIN logical_sessions s USING(logical_session_id) WHERE s.project_id=? AND q.state IN ('queued','unknown')",session.projectId), 409, "VOICE_QUEUE_PENDING", "请先处理项目中的待执行队列");
      const binding: VoiceBinding = { voiceId:newId("voice"),logicalSessionId:id,projectId:session.projectId,machineId:session.machineId,executionSegmentId:session.executionSegmentId,nativeThreadId:session.nativeThreadId,contentEpoch:session.contentEpoch,...connection };
      const at=nowIso();
      this.db.run("INSERT INTO voice_sessions(voice_id,logical_session_id,project_id,machine_id,owner_id,lease_id,binding_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'starting',?,?)", binding.voiceId,id,session.projectId,session.machineId,principal.clientSessionId,leaseId,JSON.stringify(binding),at,at);
      return binding;
    });
  }
  keepAlive(principal: Principal, id: string, coordination: CoordinationService) {
    const row = this.get(id);
    invariant(row && ["starting", "active"].includes(row.state) && row.owner_id === principal.clientSessionId && this.validOwner(row), 409, "VOICE_CONTROL_EXPIRED", "语音控制权已失效，请重新开始");
    const lease = this.db.get<{version: number}>("SELECT version FROM control_leases WHERE control_lease_id=?", row.lease_id)!;
    return coordination.renewLease(principal, row.logical_session_id, row.lease_id, lease.version, VOICE_CONTROL_TTL_SECONDS);
  }
  recordCloseReason(id: string, reason: unknown) {
    // Fixed categories only: never persist browser text, SDP, audio or transcripts.
    const allowed = ["USER_HANGUP", "PAGE_HIDDEN", "PAGE_LEFT", "USER_LOGOUT", "OTHER_CALL_STARTED", "CLIENT_DISPOSED", "CLIENT_START_FAILED", "AUDIO_DISCONNECTED", "AUDIO_FAILED", "CONNECT_TIMEOUT", "SERVER_ERROR", "SIGNAL_INVALID", "SIGNAL_FAILED", "SIGNAL_CLOSED", "NATIVE_CLOSED"];
    if (typeof reason !== "string" || !allowed.includes(reason)) return;
    this.db.run("UPDATE voice_sessions SET binding_json=json_set(binding_json,'$.closeReason',?,'$.closeRecordedAt',?) WHERE voice_id=? AND json_extract(binding_json,'$.closeReason') IS NULL",reason,nowIso(),id);
  }
  get(id: string) { return this.db.get<VoiceRow>("SELECT * FROM voice_sessions WHERE voice_id=?",id); }
  pending(machineId?: string) { return machineId ? this.db.all<VoiceRow>("SELECT * FROM voice_sessions WHERE machine_id=? AND state<>'closed'",machineId) : this.db.all<VoiceRow>("SELECT * FROM voice_sessions WHERE state<>'closed'"); }
  state(id: string, state: "active" | "closing" | "unknown" | "closed") {
    this.db.run("UPDATE voice_sessions SET state=?,updated_at=? WHERE voice_id=? AND state<>'closed'",state,nowIso(),id);
  }
  stopped(id: string, through: number) {
    invariant(Number.isSafeInteger(through) && through>=0,400,"VOICE_INVALID","Invalid voice event boundary");
    this.db.run("UPDATE voice_sessions SET state='closing',closed_through=?,updated_at=? WHERE voice_id=? AND state<>'closed'",through,nowIso(),id);
  }
  finish(row: VoiceRow) {
    if(row.closed_through===null) return false;
    const binding=JSON.parse(row.binding_json) as VoiceBinding;
    const next=this.db.get<{next_expected_host_seq:number}>("SELECT next_expected_host_seq FROM producer_streams WHERE machine_id=? AND producer_epoch=? AND quarantined=0",row.machine_id,binding.producerEpoch)?.next_expected_host_seq;
    if(next===undefined || next<=row.closed_through) return false;
    this.state(row.voice_id,"closed"); return true;
  }
  validOwner(row: VoiceRow) {
    return Boolean(this.db.get("SELECT 1 FROM control_leases l JOIN client_sessions h ON h.client_session_id=l.holder_client_session_id JOIN client_sessions c ON c.user_id=h.user_id AND c.workspace_id=h.workspace_id JOIN users u ON u.user_id=c.user_id WHERE l.control_lease_id=? AND c.client_session_id=? AND h.revoked_at IS NULL AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND l.state='active' AND l.expires_at>? AND c.revoked_at IS NULL AND c.expires_at>? AND u.disabled_at IS NULL",row.lease_id,row.owner_id,nowIso(),nowIso()));
  }
}

export function validVoiceOffer(value: unknown): value is string {
  return typeof value === "string" && value.length <= 65_536 && value.startsWith("v=0\r\n") && value.includes("m=audio ") && !value.includes("\0");
}
