import type {ControlPlaneDatabase} from './db.js';
import type {RegistryService} from './registry.js';
import type {Principal} from './auth.js';
import {newId,nowIso,payloadHash as hashPayload} from './crypto.js';
import {invariant} from './errors.js';

export interface VoiceTodo {
 todo_id:string;workspace_id:string;user_id:string;source_voice_id:string|null;mutation_key:string;create_hash:string;intent:string;
 session_id:string|null;state:'pending'|'dispatched'|'cancelled';revision:number;created_at:string;updated_at:string;
}
export interface StoredVoiceJob {job_id:string;session_id:string;command_id:string;native_turn_id:string|null;state:string;created_at:string;}
const terminal=(state:string)=>['completed','failed','interrupted'].includes(state);
/** Durable user-owned intent and result ledger. None of these methods dispatch host work. */
export class VoiceTaskStore {
 constructor(private db:ControlPlaneDatabase,private registry:RegistryService){}
 get(principal:Principal,id:string) {
  const todo=this.db.get<VoiceTodo>('SELECT * FROM panel_voice_todos WHERE todo_id=? AND workspace_id=? AND user_id=?',id,principal.workspaceId,principal.userId);
  invariant(todo,404,'VOICE_TODO_NOT_FOUND','没有此语音待办');return todo;
 }
 save(principal:Principal,input:{intent:unknown;sessionId?:unknown;key:unknown},voiceId:string|null=null) {
  invariant(typeof input.intent==='string'&&input.intent.trim().length>0&&input.intent.length<=20000,400,'VOICE_TODO_INPUT','待办内容不能为空且不能超过 20000 字符');
  invariant(typeof input.key==='string'&&input.key.length>0&&input.key.length<=200,400,'VOICE_TODO_INPUT','需要稳定的保存标识');
  invariant(input.sessionId===undefined||input.sessionId===null||typeof input.sessionId==='string',400,'VOICE_TODO_INPUT','会话标识无效');
  const sessionId=typeof input.sessionId==='string'?input.sessionId:null;
  if(sessionId)this.registry.getSession(principal,sessionId);
  const fingerprint=hashPayload({intent:input.intent,sessionId});
  const prior=this.db.get<VoiceTodo>('SELECT * FROM panel_voice_todos WHERE workspace_id=? AND user_id=? AND mutation_key=?',principal.workspaceId,principal.userId,input.key);
  if(prior){invariant(prior.create_hash===fingerprint,409,'IDEMPOTENCY_KEY_REUSE','保存标识已用于不同内容');return prior;}
  const id=newId('vtodo'),at=nowIso();
  this.db.run("INSERT INTO panel_voice_todos VALUES(?,?,?,?,?,?,?,?, 'pending',1,?,?)",id,principal.workspaceId,principal.userId,voiceId,input.key,fingerprint,input.intent,sessionId,at,at);
  return this.get(principal,id);
 }
 update(principal:Principal,id:string,input:Record<string,unknown>) {
  if(input.nativeTurnId!==undefined) return this.completeContinuation(principal,id,input);
  const todo=this.get(principal,id);
  invariant(todo.state==='pending',409,'VOICE_TODO_LOCKED','已经派发或取消的待办不能修改；重试须另建待办并明确确认');
  invariant(input.revision===todo.revision,409,'VOICE_TODO_STALE','待办已变化，请重新读取');
  const intent=input.intent===undefined?todo.intent:input.intent;
  const sessionId=input.sessionId===undefined?todo.session_id:input.sessionId;
  invariant(typeof intent==='string'&&intent.trim().length>0&&intent.length<=20000,400,'VOICE_TODO_INPUT','待办内容无效');
  invariant(sessionId===null||typeof sessionId==='string',400,'VOICE_TODO_INPUT','会话标识无效');
  if(sessionId)this.registry.getSession(principal,sessionId);
  invariant(input.state===undefined||['pending','cancelled'].includes(String(input.state)),400,'VOICE_TODO_INPUT','待办状态无效');
  this.db.run('UPDATE panel_voice_todos SET intent=?,session_id=?,state=?,revision=revision+1,updated_at=? WHERE todo_id=? AND revision=?',intent,sessionId,String(input.state??'pending'),nowIso(),id,todo.revision);
  return this.get(principal,id);
 }
 /** Explicit owner-confirmed reconciliation; never changes/replays the original job. */
 completeContinuation(principal:Principal,id:string,input:Record<string,unknown>) {
  return this.db.transaction(()=>{
   const todo=this.get(principal,id);
   invariant(input.confirmed===true,400,'VOICE_RESULT_CONFIRM','需要用户明确确认此续办轮次完成了原事项');
   invariant(typeof input.nativeTurnId==='string'&&input.nativeTurnId.length>0&&input.nativeTurnId.length<=200,400,'VOICE_TODO_INPUT','需要确切的续办轮次');
   invariant(todo.session_id&&(input.sessionId===undefined||input.sessionId===todo.session_id),404,'VOICE_TODO_TARGET','续办必须属于待办原会话');
   const session=this.registry.getSession(principal,todo.session_id);
   invariant(input.intent===undefined&&input.state===undefined,400,'VOICE_TODO_INPUT','完成更正不能同时修改意图或派发状态');
   const job=this.db.get<StoredVoiceJob>('SELECT * FROM panel_voice_jobs WHERE job_id=(SELECT job_id FROM panel_voice_task_records WHERE todo_id=?)',id);
   invariant(todo.state==='dispatched'&&job&&terminal(job.state),409,'VOICE_RESULT_PENDING','原任务尚未确定结束，不能更正');
   invariant(input.jobId===undefined||input.jobId===job.job_id,404,'VOICE_TODO_TARGET','任务标识与待办不匹配');
   const prior=this.db.get<{native_turn_id:string}>('SELECT native_turn_id FROM panel_voice_todo_resolutions WHERE todo_id=?',id);
   if(prior){invariant(prior.native_turn_id===input.nativeTurnId,409,'VOICE_TODO_RESOLVED','此事项已有完成更正，不能覆盖');return todo;}
   invariant(input.revision===todo.revision,409,'VOICE_TODO_STALE','待办已变化，请重新读取');
   invariant(job.native_turn_id!==input.nativeTurnId,409,'VOICE_TODO_EVIDENCE','需要独立的手动续办轮次');
   invariant(this.db.get<{sync_content:number}>('SELECT sync_content FROM projects WHERE project_id=?',session.projectId)?.sync_content,403,'HISTORY_CONTENT_DISABLED','未授权读取此项目正文');
   const rows=this.db.all<{event_id:string;type:string;body_json:string;payload_ref:string;session_seq:number}>(`SELECT e.event_id,e.type,b.body_json,e.payload_ref,e.session_seq FROM durable_events e JOIN content_blobs b USING(payload_ref)
    WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.content_epoch=? AND e.source_kind='agent'
    AND e.received_at>=? AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>?
    AND (e.type IN ('turn.completed','turn.failed','turn.interrupted') OR (e.type='item.completed' AND json_extract(b.body_json,'$.item.type')='agentMessage' AND json_extract(b.body_json,'$.item.phase')='final_answer')) ORDER BY e.session_seq DESC LIMIT 20`,
    todo.session_id,input.nativeTurnId,session.contentEpoch,job.created_at,nowIso());
   const end=rows.find(row=>row.type!=='item.completed');
   const latestEnd=this.db.get<{event_id:string}>("SELECT event_id FROM durable_events WHERE logical_session_id=? AND native_turn_id=? AND content_epoch=? AND source_kind='agent' AND type IN ('turn.completed','turn.failed','turn.interrupted') ORDER BY session_seq DESC LIMIT 1",todo.session_id,input.nativeTurnId,session.contentEpoch);
   const endBody=JSON.parse(end?.body_json??'{}');
   invariant(end?.event_id===latestEnd?.event_id&&end?.type==='turn.completed'&&endBody.turn?.status==='completed'&&endBody.turn?.id===input.nativeTurnId,409,'VOICE_TODO_EVIDENCE','未找到该会话有效的原生完成证据；不能凭空更正');
   const final=rows.find(row=>{const item=JSON.parse(row.body_json).item;return row.type==='item.completed'&&row.session_seq<end.session_seq&&item?.type==='agentMessage'&&item.phase==='final_answer'&&typeof item.text==='string'&&item.text.trim()&&!item.truncated;});
   invariant(final,409,'VOICE_TODO_EVIDENCE','缺少完整可用的原生最终回复');
   this.capture(job);
   const at=nowIso(),resultHash=hashPayload(JSON.parse(final.body_json).item.text);
   this.db.run('INSERT INTO panel_voice_todo_resolutions VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,job.job_id,todo.session_id,input.nativeTurnId,end.event_id,final.event_id,final.payload_ref,session.contentEpoch,resultHash,principal.userId,at);
   this.db.run('UPDATE panel_voice_todos SET revision=revision+1,updated_at=? WHERE todo_id=?',at,id);
   this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,actorClientSessionId:principal.clientSessionId,action:'voice.todo.manual_completion',metadata:{todoId:id,jobId:job.job_id,originalJobState:job.state,sessionId:todo.session_id,nativeTurnId:input.nativeTurnId,completionEventId:end.event_id,finalEventId:final.event_id,resultHash}});
   return this.get(principal,id);
  });
 }
 resolution(principal:Principal,id:string) {
  const todo=this.get(principal,id);
  const row=this.db.get<{native_turn_id:string;session_id:string;created_at:string;actor_user_id:string;final_payload_ref:string;content_epoch:number;result_hash:string}>('SELECT * FROM panel_voice_todo_resolutions WHERE todo_id=?',id);
  if(!row)return null;
  this.registry.getSession(principal,row.session_id);
  const body=this.db.get<{body_json:string}>(`SELECT b.body_json FROM content_blobs b JOIN logical_sessions s ON s.logical_session_id=? JOIN projects p ON p.project_id=s.project_id
    WHERE b.payload_ref=? AND b.deleted_at IS NULL AND b.expires_at>? AND s.deleted_at IS NULL AND s.content_epoch=? AND p.sync_content=1
    AND EXISTS(SELECT 1 FROM durable_events e WHERE e.event_id=(SELECT final_event_id FROM panel_voice_todo_resolutions WHERE todo_id=?) AND e.payload_state='present' AND e.content_epoch=s.content_epoch)`,todo.session_id,row.final_payload_ref,nowIso(),row.content_epoch,id);
  return {state:'completed' as const,kind:'manual_continuation' as const,sessionId:row.session_id,nativeTurnId:row.native_turn_id,createdAt:row.created_at,actorUserId:row.actor_user_id,source:'synced_native_history',result:body?JSON.parse(body.body_json).item.text:'',historyLimited:!body};
 }
 linkedJob(id:string) {return this.db.get<{job_id:string;session_id:string;dispatch_prompt:string}>('SELECT job_id,session_id,dispatch_prompt FROM panel_voice_task_records WHERE todo_id=?',id);}
 link(todo:VoiceTodo,job:StoredVoiceJob,target:{machineId:string;projectId:string;contentEpoch:number},prompt:string) {
  this.db.run(`INSERT INTO panel_voice_task_records(job_id,todo_id,machine_id,project_id,session_id,original_intent,dispatch_prompt,native_turn_id,state,content_epoch,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,job.job_id,todo.todo_id,target.machineId,target.projectId,job.session_id,todo.intent,prompt,job.native_turn_id,job.state,target.contentEpoch,job.created_at,nowIso());
  this.db.run("UPDATE panel_voice_todos SET state='dispatched',session_id=?,revision=revision+1,updated_at=? WHERE todo_id=?",job.session_id,nowIso(),todo.todo_id);
 }
 capture(job:StoredVoiceJob) {
  this.db.run('UPDATE panel_voice_task_records SET state=?,native_turn_id=?,updated_at=? WHERE job_id=?',job.state,job.native_turn_id,nowIso(),job.job_id);
  if(!terminal(job.state))return;
  const policy=this.db.get<{sync_content:number;content_epoch:number;deleted_at:string|null;stored_epoch:number}>(`SELECT p.sync_content,s.content_epoch,s.deleted_at,r.content_epoch stored_epoch
    FROM panel_voice_task_records r JOIN logical_sessions s ON s.logical_session_id=r.session_id JOIN projects p ON p.project_id=s.project_id WHERE r.job_id=?`,job.job_id);
  if(!policy)return;
  const available=policy.sync_content&&policy.deleted_at===null&&policy.content_epoch===policy.stored_epoch;
  const rows=available&&job.native_turn_id?this.db.all<{body_json:string|null;payload_ref:string;expires_at:string;type:string}>(`SELECT e.type,e.payload_ref,b.expires_at,
    CASE WHEN e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND e.content_epoch=? THEN b.body_json END body_json
    FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=?
    AND e.type IN ('item.completed','turn.completed','turn.failed','turn.interrupted') ORDER BY e.session_seq DESC LIMIT 120`,nowIso(),policy.stored_epoch,job.session_id,job.native_turn_id):[];
  const output=rows.find(row=>{const p=JSON.parse(row.body_json??'{}');return row.type==='item.completed'&&p.item?.type==='agentMessage'&&typeof p.item.text==='string';});
  const failure=this.db.get<{detail_json:string}>('SELECT detail_json FROM command_lifecycle WHERE command_id=? AND (json_extract(detail_json,\'$.error\') IS NOT NULL OR json_extract(detail_json,\'$.code\') IS NOT NULL) ORDER BY lifecycle_id DESC LIMIT 1',job.command_id);
  const detail=JSON.parse(failure?.detail_json??'{}');
  const native=rows.find(row=>row.type!=='item.completed');
  const cause=JSON.parse(native?.body_json??'{}').turn?.error??detail.error??detail;
  const error=job.state==='failed'||job.state==='interrupted'?{code:typeof cause.code==='string'?cause.code:'TASK_FAILED',message:typeof cause.message==='string'?cause.message:'未提供失败详情'}:null;
  const result=output?JSON.parse(output.body_json!).item.text.slice(-6000):'';
  const snapshot={result,error,historyLimited:!available||rows.some(row=>!row.body_json),executionStarted:job.native_turn_id?true:error?.code==='MACHINE_DRAINING'?false:null};
  this.db.run('UPDATE panel_voice_task_records SET result_json=?,result_payload_ref=?,result_expires_at=? WHERE job_id=?',JSON.stringify(snapshot),output?.payload_ref??native?.payload_ref??null,output?.expires_at??native?.expires_at??null,job.job_id);
 }
 purgeUnavailable() {
  // Result copies obey the same deletion, retention and content-sharing boundary as their evidence.
  this.db.run(`UPDATE panel_voice_task_records SET result_json='{"result":"","historyLimited":true}',result_payload_ref=NULL,result_expires_at=NULL
   WHERE result_json<>'{}' AND (session_id IN (SELECT s.logical_session_id FROM logical_sessions s JOIN projects p ON p.project_id=s.project_id WHERE s.deleted_at IS NOT NULL OR p.sync_content=0 OR s.content_epoch<>panel_voice_task_records.content_epoch)
   OR result_expires_at<=? OR (result_payload_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM content_blobs b WHERE b.payload_ref=panel_voice_task_records.result_payload_ref AND b.deleted_at IS NULL)))`,nowIso());
 }
 describe(principal:Principal,todo:VoiceTodo) {
  let target:null|{machineId:string;projectId:string;sessionId:string;host:string;project:string;title:string}=null;
  let targetUnavailable=false,statusFreshness='last_known';
  if(todo.session_id)try{const s=this.registry.getSession(principal,todo.session_id);statusFreshness=s.reachability==='live'&&this.registry.getMachine(principal,s.machineId).reachability==='online'?'live':'last_known';target={machineId:s.machineId,projectId:s.projectId,sessionId:s.logicalSessionId,host:this.registry.getMachine(principal,s.machineId).name,project:s.projectAlias,title:s.title};}catch{targetUnavailable=true;}
  this.purgeUnavailable();
  const row=this.db.get<{job_id:string;native_turn_id:string|null;state:string;result_json:string;acknowledged_at:string|null;reported_call_id:string|null}>(`SELECT r.*,j.reported_call_id FROM panel_voice_task_records r JOIN panel_voice_jobs j USING(job_id) WHERE r.todo_id=?`,todo.todo_id);
  const resolution=targetUnavailable?null:this.resolution(principal,todo.todo_id);
  const resolved=Boolean(this.db.get('SELECT 1 FROM panel_voice_todo_resolutions WHERE todo_id=?',todo.todo_id));
  return {resolution,todoId:todo.todo_id,intent:todo.intent,intentUnavailable:!todo.intent,state:resolved?'completed':todo.state,dispatchState:todo.state,revision:todo.revision,sourceVoiceId:todo.source_voice_id,createdAt:todo.created_at,updatedAt:todo.updated_at,target,targetUnavailable,
   job:row?{jobId:row.job_id,nativeTurnId:row.native_turn_id,state:row.state,statusFreshness,...(targetUnavailable?{result:'',historyLimited:true}:JSON.parse(row.result_json)),deliveredToVoice:Boolean(row.reported_call_id),acknowledgedAt:row.acknowledged_at}:null};
 }
 list(principal:Principal,options:{cursor?:unknown;view?:unknown}={}) {
  invariant(options.view===undefined||options.view==='all'||options.view==='recover',400,'VOICE_TODO_VIEW','记录范围无效');
  let anchor:{createdAt:string;todoId:string}|undefined;
  if(options.cursor!==undefined) {
   invariant(typeof options.cursor==='string'&&options.cursor.length<=1000,400,'VOICE_TODO_CURSOR','分页标识无效');
   try{anchor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));}catch{invariant(false,400,'VOICE_TODO_CURSOR','分页标识无效');}
   invariant(anchor&&typeof anchor.createdAt==='string'&&typeof anchor.todoId==='string',400,'VOICE_TODO_CURSOR','分页标识无效');
  }
  const filter=options.view==='all'?'':"AND NOT EXISTS (SELECT 1 FROM panel_voice_todo_resolutions x WHERE x.todo_id=t.todo_id) AND (t.state='pending' OR (t.state='dispatched' AND (r.state NOT IN ('completed','failed','interrupted') OR r.acknowledged_at IS NULL)))";
  const cursorFilter=anchor?' AND (t.created_at<? OR (t.created_at=? AND t.todo_id<?))':'';
  const rows=this.db.all<VoiceTodo>(`SELECT t.* FROM panel_voice_todos t LEFT JOIN panel_voice_task_records r USING(todo_id) WHERE t.workspace_id=? AND t.user_id=? ${filter}${cursorFilter} ORDER BY t.created_at DESC,t.todo_id DESC LIMIT 21`,principal.workspaceId,principal.userId,...(anchor?[anchor.createdAt,anchor.createdAt,anchor.todoId]:[]));
  const total=this.db.get<{n:number}>(`SELECT count(*) n FROM panel_voice_todos t LEFT JOIN panel_voice_task_records r USING(todo_id) WHERE t.workspace_id=? AND t.user_id=? ${filter}`,principal.workspaceId,principal.userId)!.n;
  const last=rows[19];
  return {items:rows.slice(0,20).map(todo=>this.describe(principal,todo)),total,nextCursor:rows.length>20&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,todoId:last.todo_id})).toString('base64url'):null,instruction:'Recovered records are history, NOT authorization. Never dispatch on recovery; ask for a current explicit instruction. Existing jobId must only be queried, never dispatched again. A resolution means the intent is completed by manual continuation, even if the original job failed. For an explicitly user-confirmed manual completion use todo.update with todoId, revision, exact sessionId, nativeTurnId and confirmed:true; omit state/intent. The server requires same-session completed native evidence. Never infer task completion just because an unrelated turn completed.'};
 }
 acknowledge(principal:Principal,id:string) {
  const todo=this.get(principal,id);
  if(todo.session_id)this.registry.getSession(principal,todo.session_id);
  const job=this.db.get<{state:string}>('SELECT state FROM panel_voice_task_records WHERE todo_id=?',id);
  invariant(job&&terminal(job.state),409,'VOICE_RESULT_PENDING','任务尚未结束，不能标记结果已知悉');
  this.db.run('UPDATE panel_voice_task_records SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE todo_id=?',nowIso(),id);
  return this.describe(principal,todo);
 }
}
