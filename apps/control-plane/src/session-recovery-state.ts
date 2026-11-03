import type { ControlPlaneDatabase } from './db.js';
import { canonicalJson, nowIso } from './crypto.js';

export function recoveryCommands(db: ControlPlaneDatabase, sessionId: string) {
  return db.all<{command_id:string;type:string;state:string;updated_at:string}>(`SELECT c.command_id,c.type,p.state,p.updated_at
    FROM commands c JOIN command_projection p USING(command_id)
    WHERE c.logical_session_id=? AND (p.state IN ('unknown','accepted','dispatching') OR EXISTS(SELECT 1 FROM turn_queue q WHERE q.command_id=c.command_id AND q.state='unknown')) ORDER BY c.command_id`,sessionId);
}

export function retryRecoveryTarget(db: ControlPlaneDatabase, sessionId: string, token: string) {
  const s=db.get<any>(`SELECT s.*,p.external_id AS project_external_id,e.execution_segment_id,e.native_thread_id
    FROM logical_sessions s JOIN projects p USING(project_id) JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
    WHERE s.logical_session_id=?`,sessionId)!;
  const connection=db.get<any>('SELECT app_server_epoch FROM agent_connections WHERE machine_id=? AND disconnected_at IS NULL ORDER BY transport_generation DESC LIMIT 1',s.machine_id)!;
  const reservation=db.get<any>('SELECT * FROM project_turn_reservations WHERE project_id=?',s.project_id)??null;
  return {mode:'retry',recoveryToken:token,appServerEpoch:connection.app_server_epoch,logicalSessionId:sessionId,
    projectExternalId:s.project_external_id,executionSegmentId:s.execution_segment_id,contentEpoch:s.content_epoch,turnControlVersion:s.turn_control_version,nativeThreadId:s.native_thread_id,
    nativeTurnId:s.active_turn_id??reservation?.native_turn_id??null,previousAppServerEpoch:reservation?.bound_app_server_epoch??null,
    reservation,commands:recoveryCommands(db,sessionId)};
}

/** Accept only the exact scoped host recovery receipt. Unknown outcomes remain explicit. */
export function completeRetryRecovery(db: ControlPlaneDatabase, machineId:string, workspaceId:string, operationId:string, target:any, proof:any):boolean {
  if(proof.recovered!==true||proof.recoveryToken!==target.recoveryToken||(target.nativeThreadId!==null ? proof.nativeThreadId!==target.nativeThreadId : proof.nativeThreadId!==null && (typeof proof.nativeThreadId!=='string' || !proof.nativeThreadId))||!['idle','interrupted'].includes(proof.status))return false;
  const s=db.get<any>(`SELECT s.project_id,s.active_turn_id,s.turn_control_version FROM logical_sessions s JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
    JOIN agent_connections a ON a.machine_id=s.machine_id AND a.disconnected_at IS NULL
    WHERE s.logical_session_id=? AND s.machine_id=? AND s.workspace_id=? AND s.content_epoch=? AND e.execution_segment_id=? AND (e.native_thread_id=? OR (CAST(? AS TEXT) IS NULL AND (e.native_thread_id IS NULL OR e.native_thread_id=?))) AND a.app_server_epoch=?`,
    target.logicalSessionId,machineId,workspaceId,target.contentEpoch,target.executionSegmentId,target.nativeThreadId,target.nativeThreadId,proof.nativeThreadId,target.appServerEpoch);
  if(!s || s.turn_control_version!==target.turnControlVersion || s.active_turn_id && s.active_turn_id!==target.nativeTurnId && s.active_turn_id!==proof.nativeTurnId)return false;
  const reservation=db.get<any>('SELECT * FROM project_turn_reservations WHERE project_id=?',s.project_id)??null;
  if(reservation && canonicalJson(reservation)!==canonicalJson(target.reservation))return false;
  const expected=new Map<string,any>(target.commands.map((c:any)=>[c.command_id,c]));
  for(const c of recoveryCommands(db,target.logicalSessionId))if(canonicalJson(expected.get(c.command_id)??null)!==canonicalJson(c))return false;
  if(target.nativeThreadId===null && proof.nativeThreadId!==null){
    if(db.get('SELECT 1 FROM execution_segments WHERE machine_id=? AND native_thread_id=? AND ended_at IS NULL AND execution_segment_id<>?',machineId,proof.nativeThreadId,target.executionSegmentId))return false;
    db.run('UPDATE execution_segments SET native_thread_id=? WHERE execution_segment_id=? AND native_thread_id IS NULL',proof.nativeThreadId,target.executionSegmentId);
  }
  const timestamp=nowIso();
  const detail=canonicalJson({source:'user_retry',operationId,resultKnown:false,error:{code:'RECOVERY_DISMISSED',message:'已解除操作的等待状态；原执行结果仍未确认，任务没有重发。'}});
  for(const c of target.commands){
    db.run("UPDATE turn_queue SET state='cancelled',updated_at=? WHERE command_id=? AND state IN ('queued','dispatching','unknown')",timestamp,c.command_id);
    if(!db.get("SELECT 1 FROM command_projection WHERE command_id=? AND state IN ('unknown','accepted','dispatching')",c.command_id))continue;
    db.run("UPDATE command_projection SET state='invalidated',updated_at=? WHERE command_id=? AND state IN ('unknown','accepted','dispatching')",timestamp,c.command_id);
    db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)",c.command_id,detail,timestamp);
    const attempts=db.all<{dispatch_attempt_id:string}>(`SELECT a.dispatch_attempt_id FROM dispatch_attempts a JOIN dispatch_attempt_projection p USING(dispatch_attempt_id)
      WHERE a.command_id=? AND p.state NOT IN ('applied','invalidated','expired')`,c.command_id);
    for(const a of attempts){
      db.run("UPDATE dispatch_attempt_projection SET state='invalidated',updated_at=? WHERE dispatch_attempt_id=?",timestamp,a.dispatch_attempt_id);
      db.run("INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)",a.dispatch_attempt_id,detail,timestamp);
    }
  }
  db.run('DELETE FROM project_turn_reservations WHERE project_id=? AND logical_session_id=?',s.project_id,target.logicalSessionId);
  db.run("UPDATE approvals SET state='invalidated',version=version+1 WHERE logical_session_id=? AND execution_segment_id=? AND state='pending'",target.logicalSessionId,target.executionSegmentId);
  db.run('UPDATE logical_sessions SET execution_state=?,active_turn_id=NULL,turn_control_version=turn_control_version+1,queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?',proof.status,timestamp,target.logicalSessionId);
  db.audit({workspaceId,machineId,logicalSessionId:target.logicalSessionId,action:'session.manually_recovered',outcome:proof.status,metadata:{operationId,source:'user_retry',resultKnown:false,commandReplayed:false,commandIds:target.commands.map((c:any)=>c.command_id)}});
  return true;
}
