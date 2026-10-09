import {LongTermPreferences} from './long-term-preferences.js';
import type { SessionHistoryService } from './session-history.js';
import { assertVoiceAdmission } from "./voice-deployment.js";
import { VoiceTaskStore } from "./voice-task-store.js";
import { SessionProgressService } from "./session-progress.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { CoordinationService } from "./coordination.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { newId, nowIso, payloadHash as hashPayload } from "./crypto.js";

export interface PanelCall { voice_id:string; workspace_id:string; user_id:string; owner_id:string; machine_id:string; binding_json:string; state:string; created_at:string; }
interface PanelJob { job_id:string; user_id:string; workspace_id:string; voice_id:string; request_id:string; session_id:string; command_id:string; native_turn_id:string|null; state:string; reported_call_id:string|null; created_at:string; }
/** Global coordinator only routes work. Existing session commands enforce permissions and project exclusivity. */
export class PanelVoiceService {
  readonly memory:VoiceTaskStore;
  private memoryCursor=0;
  constructor(private db:ControlPlaneDatabase,private registry:RegistryService,private coordination:CoordinationService,private progress=new SessionProgressService(db,registry),private historyService?:SessionHistoryService) {this.memory=new VoiceTaskStore(db,registry);}
  async history(principal:Principal,voiceId:string,input:Record<string,unknown>) {
    this.own(principal,voiceId);
    invariant(this.historyService,409,'HISTORY_UNSUPPORTED','会话历史查询尚未接通');
    const result=await this.historyService.read(principal,input);
    this.own(principal,voiceId);
    return result;
  }
  syncSessionMemory(sessionId:string) {
    for(const job of this.db.all<PanelJob>("SELECT * FROM panel_voice_jobs WHERE session_id=?",sessionId))this.refresh(job);
  }
  syncMemory(principal?:Principal) {
    this.memory.purgeUnavailable();
    const jobs=principal?this.db.all<PanelJob>("SELECT * FROM panel_voice_jobs WHERE workspace_id=? AND user_id=?",principal.workspaceId,principal.userId)
      :this.db.all<PanelJob&{rowid:number}>("SELECT j.rowid,j.* FROM panel_voice_jobs j JOIN panel_voice_task_records r USING(job_id) WHERE j.rowid>? AND (j.state NOT IN ('completed','failed','interrupted') OR r.result_json='{}') ORDER BY j.rowid LIMIT 100",this.memoryCursor);
    for(const job of jobs)this.refresh(job);
    if(!principal)this.memoryCursor=jobs.length===100?(jobs.at(-1) as PanelJob&{rowid:number}).rowid:0;
  }
  recover(principal:Principal,options:{cursor?:unknown;view?:unknown}={}) {this.syncMemory(principal);return this.memory.list(principal,options);}

  start(principal:Principal,machineId:string,binding:Record<string,unknown>) {
    assertVoiceAdmission(this.db);
    const machine=this.registry.getMachine(principal,machineId);
    invariant(!machine.maintenance,409,"MACHINE_DRAINING","主机正在维护，等待安全重启；完成后才能开始新通话");
    invariant(!this.db.get("SELECT 1 FROM panel_voice_calls WHERE user_id=? AND state<>'closed'",principal.userId),409,"PANEL_VOICE_BUSY","已有面板总控通话，请先结束原通话");
    const voiceId=newId("pvoice");
    this.db.run("INSERT INTO panel_voice_calls VALUES(?,?,?,?,?,?,'starting',?)",voiceId,principal.workspaceId,principal.userId,principal.clientSessionId,machineId,JSON.stringify(binding),nowIso());
    return this.get(voiceId)!;
  }
  get(id:string) {return this.db.get<PanelCall>("SELECT * FROM panel_voice_calls WHERE voice_id=?",id);}
  pending() {return this.db.all<PanelCall>("SELECT * FROM panel_voice_calls WHERE state<>'closed'");}
  state(id:string,state:string) {this.db.run("UPDATE panel_voice_calls SET state=? WHERE voice_id=?",state,id);}
  recordFailure(id:string,message:unknown) {
    const code=typeof message==='string'&&/^VOICE_(?:HTTP_(?:400|401|403|404|408|409|429|500|502|503|504)|AUTH|LIMIT|SDP|TIMEOUT|SIDEBAND|BUSY|FENCED|TARGET_CHANGED|UNAVAILABLE|POLICY_NOT_PROVEN|POLICY_UNVERIFIED|PROCESS_UNVERIFIED|CONFIG|NATIVE_ERROR)$/.test(message)?message:'VOICE_NATIVE_ERROR';
    this.db.run("UPDATE panel_voice_calls SET binding_json=json_set(binding_json,'$.failureCode',?) WHERE voice_id=? AND json_extract(binding_json,'$.failureCode') IS NULL",code,id);
    return code;
  }
  recordCloseReason(id:string,reason:unknown) {
    const code=typeof reason==='string'&&['USER_HANGUP','PAGE_HIDDEN','PAGE_LEFT','USER_LOGOUT','OTHER_CALL_STARTED','CLIENT_START_FAILED','AUDIO_DISCONNECTED','AUDIO_FAILED','CONNECT_TIMEOUT','SIGNAL_INVALID','SIGNAL_FAILED','CLIENT_DISPOSED','SIGNAL_CLOSED','NATIVE_CLOSED','HOST_DISCONNECTED','OWNER_EXPIRED','SERVER_ERROR'].includes(reason)?reason:'SERVER_ERROR';
    this.db.run("UPDATE panel_voice_calls SET binding_json=json_set(binding_json,'$.closeReason',?,'$.closeRequestedAt',?) WHERE voice_id=? AND json_extract(binding_json,'$.closeReason') IS NULL",code,nowIso(),id);
  }
  closeOrphans() {this.db.run("UPDATE panel_voice_calls SET state='closed' WHERE state<>'closed'");}
  private own(principal:Principal,voiceId:string,allowStarting=false) {
    const call=this.get(voiceId);
    invariant(call && call.workspace_id===principal.workspaceId && call.user_id===principal.userId && call.owner_id===principal.clientSessionId && (call.state==='active'||allowStarting&&call.state==='starting'),403,"PANEL_VOICE_OWNER","总控通话已结束或无权操作");
    this.registry.getMachine(principal,call.machine_id);
    return call;
  }
  private refresh(job:PanelJob):PanelJob {
    if(["completed","failed","interrupted"].includes(job.state)){this.memory.capture(job);return job;}
    const command=this.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",job.command_id);
    let state=job.state, turnId=job.native_turn_id;
    if(!turnId) turnId=this.db.get<{native_turn_id:string}>("SELECT native_turn_id FROM durable_events e JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.type='turn.started' AND json_extract(b.body_json,'$.commandId')=? ORDER BY session_seq LIMIT 1",job.session_id,job.command_id)?.native_turn_id??null;
    // Command acknowledgments still identify the turn when project content sync is disabled,
    // or a very fast task completed before the synthetic turn.started event was emitted.
    if(!turnId) turnId=this.db.get<{native_turn_id:string}>("SELECT COALESCE(json_extract(detail_json,'$.response.nativeTurnId'),json_extract(detail_json,'$.nativeTurnId')) AS native_turn_id FROM command_lifecycle WHERE command_id=? AND native_turn_id IS NOT NULL ORDER BY lifecycle_id DESC LIMIT 1",job.command_id)?.native_turn_id??null;
    if(turnId) {
      const end=this.db.get<{type:string;body_json:string|null}>("SELECT e.type,b.body_json FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type IN ('turn.completed','turn.failed','turn.interrupted') ORDER BY session_seq DESC LIMIT 1",job.session_id,turnId);
      if(end) {const body=JSON.parse(end.body_json??'{}');state=['completed','failed','interrupted'].includes(body.turn?.status)?body.turn.status:end.type==='turn.failed'?'failed':end.type==='turn.interrupted'?'interrupted':'completed';}
      else state='running';
    } else if(command?.state==='invalidated' || command?.state==='expired' || command?.state==='cancelled') state='failed';
    else if(command?.state==='unknown') state='unknown';
    else if(command?.state==='applied') {
      const failure=this.db.get("SELECT 1 FROM command_lifecycle WHERE command_id=? AND (json_extract(detail_json,'$.ok')=0 OR json_extract(detail_json,'$.error') IS NOT NULL OR json_extract(detail_json,'$.code') IS NOT NULL)",job.command_id);
      if(failure) state='failed';
    }
    this.db.run("UPDATE panel_voice_jobs SET state=?,native_turn_id=? WHERE job_id=?",state,turnId,job.job_id);
    const updated={...job,state,native_turn_id:turnId};this.memory.capture(updated);return updated;
  }
  private jobs(principal:Principal, scope: {sessionId?:string;voiceId?:string}) {
    const filter=scope.sessionId ? "session_id=?" : "voice_id=?";
    // Include every outstanding job, even if many newer jobs have finished.
    return this.db.all<PanelJob>(`SELECT * FROM panel_voice_jobs WHERE user_id=? AND workspace_id=? AND ${filter}
      AND (state NOT IN ('completed','failed','interrupted') OR job_id IN
        (SELECT job_id FROM panel_voice_jobs WHERE user_id=? AND workspace_id=? AND ${filter} ORDER BY created_at DESC,rowid DESC LIMIT 20))
      ORDER BY created_at DESC,rowid DESC`,principal.userId,principal.workspaceId,scope.sessionId??scope.voiceId??null,
      principal.userId,principal.workspaceId,scope.sessionId??scope.voiceId??null).map(job=>this.refresh(job));
  }
  current(principal:Principal, scope?: {sessionId?:string;voiceId?:string}) {
    const jobs=scope?this.jobs(principal,scope):this.db.all<PanelJob>("SELECT * FROM panel_voice_jobs WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC,rowid DESC",principal.userId,principal.workspaceId).map(job=>this.refresh(job));
    return jobs.find(j=>!['completed','failed','interrupted'].includes(j.state))??jobs[0];
  }
  describe(principal:Principal,job:PanelJob) {
    const session=this.registry.getSession(principal,job.session_id);
    const stored=this.db.get<{todo_id:string;original_intent:string;content_epoch:number}>("SELECT todo_id,original_intent,content_epoch FROM panel_voice_task_records WHERE job_id=?",job.job_id);
    const canReadContent=Boolean(this.db.get<{sync_content:number}>("SELECT sync_content FROM projects WHERE project_id=?",session.projectId)?.sync_content && (!stored||stored.content_epoch===session.contentEpoch));
    let result='';
    const terminal=['completed','failed','interrupted'].includes(job.state);
    const command=this.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",job.command_id);
    const failure=this.db.get<{detail_json:string}>(`SELECT detail_json FROM command_lifecycle WHERE command_id=?
      AND (json_extract(detail_json,'$.error') IS NOT NULL OR json_extract(detail_json,'$.code') IS NOT NULL)
      ORDER BY lifecycle_id DESC LIMIT 1`,job.command_id);
    const detail=JSON.parse(failure?.detail_json??'{}');
    const end=canReadContent&&job.native_turn_id?this.db.get<{body_json:string|null}>("SELECT b.body_json FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type IN ('turn.completed','turn.failed','turn.interrupted') AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY session_seq DESC LIMIT 1",job.session_id,job.native_turn_id):undefined;
    const nativeError=JSON.parse(end?.body_json??'{}').turn?.error;
    const source=nativeError??detail.error??detail;
    const error=(job.state==='failed'||job.state==='interrupted')&&typeof source.code==='string'
      ? {code:source.code,message:typeof source.message==='string'?source.message:'任务失败，原因未提供'}
      : (job.state==='failed'||job.state==='interrupted')&&typeof source.message==='string'
        ? {code:'TASK_FAILED',message:source.message} : null;
    // Missing turn evidence is not proof that execution never began (timeouts/unknown outcomes).
    const executionStarted=job.native_turn_id?true:error?.code==='MACHINE_DRAINING'?false:null;
    const historyLimited=Boolean(job.native_turn_id&&terminal&&(!canReadContent||this.db.get(`SELECT 1 FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref)
      WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type IN ('item.completed','turn.completed')
      AND (e.payload_state<>'present' OR b.payload_ref IS NULL OR b.deleted_at IS NOT NULL) LIMIT 1`,job.session_id,job.native_turn_id)));
    if(canReadContent && job.native_turn_id && ['completed','failed','interrupted'].includes(job.state)) {
      const rows=this.db.all<{body_json:string}>("SELECT b.body_json FROM durable_events e JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY e.session_seq DESC LIMIT 30",job.session_id,job.native_turn_id);
      for(const row of rows) {const p=JSON.parse(row.body_json);const item=p.item;if(item?.type==='agentMessage'&&typeof item.text==='string'){result=item.text.slice(-6000);break;}}
    }
    const resolution=stored?.todo_id?this.memory.resolution(principal,stored.todo_id):null;
    return {resolution,todoState:resolution?'completed':stored?'dispatched':null,todoId:stored?.todo_id??null,originalIntent:stored?.original_intent??null,jobId:job.job_id,commandId:job.command_id,nativeTurnId:job.native_turn_id,sessionId:job.session_id,title:session.title,projectId:session.projectId,machineId:session.machineId,project:session.projectAlias,host:this.registry.getMachine(principal,session.machineId).name,state:job.state,progress:this.progress.read(principal,job.session_id,job.native_turn_id),result,historyLimited,error,executionStarted,commandState:command?.state??null,resultStatus:result?'available':executionStarted===false?'not_started':historyLimited?'history_unavailable':terminal?'no_output':'pending',link:`/sessions/${job.session_id}`};
  }
  private describeSteer(principal:Principal,commandId:string,sessionId?:unknown) {
    const row=this.db.get<{logical_session_id:string;precondition_json:string}>("SELECT logical_session_id,precondition_json FROM commands WHERE command_id=? AND workspace_id=? AND actor_user_id=? AND type='turn.steer'",commandId,principal.workspaceId,principal.userId);
    invariant(row&&(sessionId===undefined||sessionId===row.logical_session_id),404,'PANEL_COMMAND_NOT_FOUND','该范围内没有此追加指令');
    const session=this.registry.getSession(principal,row.logical_session_id);
    const command=this.coordination.getCommand(principal,commandId);
    return {action:'steer',commandId,sessionId:session.logicalSessionId,projectId:session.projectId,machineId:session.machineId,nativeTurnId:JSON.parse(row.precondition_json).nativeTurnId,commandState:command.state,outcome:command.outcome,error:command.error??null,message:'追加指令状态以主机回执为准；不会启动新的任务'};
  }
  tool(principal:Principal,voiceId:string,requestId:string,input:unknown) {
    invariant(typeof input==='object'&&input!==null&&!Array.isArray(input),400,"PANEL_INPUT","Invalid tool input");
    const args=input as Record<string,unknown>;
    this.own(principal,voiceId,args.action==='recover');
    if(typeof args.action==='string'&&['preference.list','preference.save','preference.update','preference.delete'].includes(args.action))return new LongTermPreferences(this.db).tool(principal,args);
    if(args.action==='recover')return this.recover(principal,{cursor:args.cursor,view:args.view});
    if(args.action==='todo.save') {
      const key=typeof args.idempotencyKey==='string'?args.idempotencyKey:`${voiceId}:${hashPayload({intent:args.intent,sessionId:args.sessionId??null})}`;
      return this.memory.describe(principal,this.memory.save(principal,{intent:args.intent,sessionId:args.sessionId,key},voiceId));
    }
    if(args.action==='todo.update') {
      invariant(typeof args.todoId==='string',400,'VOICE_TODO_INPUT','需要待办标识');
      return this.memory.describe(principal,this.memory.update(principal,args.todoId,args));
    }
    if(args.action==='acknowledge') {
      invariant(typeof args.todoId==='string'&&args.confirmed===true,400,'VOICE_RESULT_CONFIRM','请在用户确认已知悉结果后标记');
      this.syncMemory(principal);return this.memory.acknowledge(principal,args.todoId);
    }
    invariant(args.todoId===undefined||typeof args.todoId==='string'&&args.todoId.length>0,400,'VOICE_TODO_INPUT','待办标识无效');
    let todo=typeof args.todoId==='string'?this.memory.get(principal,args.todoId):undefined;
    if(args.action==='status'&&todo) {
      const linked=this.memory.linkedJob(todo.todo_id);
      invariant((args.sessionId===undefined||args.sessionId===todo.session_id)&&(args.jobId===undefined||args.jobId===linked?.job_id),404,'PANEL_JOB_NOT_FOUND','该待办范围内没有此任务');
      if(this.memory.resolution(principal,todo.todo_id))return {...this.memory.describe(principal,todo),scope:'todo'};
      if(linked){const job=this.db.get<PanelJob>('SELECT * FROM panel_voice_jobs WHERE job_id=?',linked.job_id)!;return {...this.describe(principal,this.refresh(job)),scope:'todo'};}
      return {...this.memory.describe(principal,todo),scope:'todo'};
    }

    if(args.action==='dispatch'&&todo) {
      const linked=this.memory.linkedJob(todo.todo_id);
      if(linked) {
        invariant((args.sessionId===undefined||args.sessionId===linked.session_id)&&(args.prompt===undefined||args.prompt===linked.dispatch_prompt),409,'VOICE_TODO_LINKED','此待办已关联其他派发内容，请查询原任务');
        const job=this.db.get<PanelJob>('SELECT * FROM panel_voice_jobs WHERE job_id=?',linked.job_id)!;
        return {...this.describe(principal,this.refresh(job)),duplicate:true};
      }
      invariant(todo.state==='pending',409,'VOICE_TODO_CANCELLED','该待办已取消，不能派发');
      invariant(args.confirmed===true,409,'VOICE_DISPATCH_CONFIRM','恢复记录不是执行授权；需要当前用户明确确认后派发');
      invariant(args.revision===todo.revision,409,'VOICE_TODO_STALE','待办已变化，请重新读取并确认');
      if(todo.session_id)invariant(args.sessionId===undefined||args.sessionId===todo.session_id,409,'VOICE_TODO_TARGET','目标不同，请先修改待办并重新确认');
      args.sessionId=args.sessionId??todo.session_id;args.prompt=args.prompt??todo.intent;
    }

    if(args.action==='status'&&typeof args.commandId==='string')return this.describeSteer(principal,args.commandId,args.sessionId);
    if(args.action==='steer') {
      invariant(typeof args.sessionId==='string'&&typeof args.nativeTurnId==='string'&&args.nativeTurnId.length>0&&typeof args.prompt==='string'&&args.prompt.trim().length>0&&args.prompt.length<=20000,400,'PANEL_INPUT','追加需要明确会话、当前 turn 和内容');
      invariant(args.todoId===undefined,400,'PANEL_INPUT','追加当前任务不能派发历史待办');
      const session=this.registry.getSession(principal,args.sessionId);
      if(args.jobId!==undefined) {
        const job=typeof args.jobId==='string'?this.db.get<PanelJob>('SELECT * FROM panel_voice_jobs WHERE job_id=? AND user_id=? AND workspace_id=? AND session_id=?',args.jobId,principal.userId,principal.workspaceId,args.sessionId):undefined;
        invariant(job&&this.refresh(job).native_turn_id===args.nativeTurnId,409,'PANEL_JOB_TARGET','任务与当前会话 turn 不匹配');
      }
      invariant(args.idempotencyKey===undefined||typeof args.idempotencyKey==='string'&&args.idempotencyKey.length>0&&args.idempotencyKey.length<=200,400,'PANEL_INPUT','追加请求标识无效');
      const mutation='panel-steer-'+hashPayload({user:principal.userId,key:args.idempotencyKey??`${voiceId}:${requestId}`});
      const previous=this.db.get<{command_id:string;logical_session_id:string;precondition_json:string;body_json:string|null}>(`SELECT c.command_id,c.logical_session_id,c.precondition_json,cc.body_json FROM commands c LEFT JOIN command_contents cc ON cc.command_id=c.command_id AND cc.deleted_at IS NULL AND cc.expires_at>? WHERE c.workspace_id=? AND c.actor_user_id=? AND c.client_mutation_id=?`,nowIso(),principal.workspaceId,principal.userId,mutation);
      if(previous) {
        invariant(previous.logical_session_id===args.sessionId&&JSON.parse(previous.precondition_json).nativeTurnId===args.nativeTurnId&&previous.body_json&&JSON.parse(previous.body_json).prompt===args.prompt,409,'IDEMPOTENCY_KEY_REUSE','追加标识已使用且内容不同或已过期，请查询原指令');
        return {...this.describeSteer(principal,previous.command_id,args.sessionId),duplicate:true};
      }
      invariant(session.activeTurnId===args.nativeTurnId,409,'ACTIVE_TURN_CONFLICT','当前任务已结束或发生变化，请重新查询；不会自动创建新任务');
      invariant(session.managed&&session.actions.steer.allowed,409,session.actions.steer.reasonCode??'PANEL_TARGET_BUSY',session.actions.steer.message??'当前会话不能追加');
      const result=this.coordination.createCommand(principal,session.logicalSessionId,{type:'turn.steer',clientMutationId:mutation,payload:{prompt:args.prompt},precondition:{nativeTurnId:args.nativeTurnId,turnControlVersion:session.turnControlVersion}},true);
      return {...this.describeSteer(principal,String(result.command.commandId),args.sessionId),duplicate:result.duplicate};
    }
    if(args.action==='search') {
      invariant(typeof args.query==='string'&&args.query.length<=200,400,"PANEL_QUERY","请提供主机、项目或会话关键词");
      const page=this.registry.listSessionsPage(principal,{q:args.query,limit:20,managed:true,...(typeof args.cursor==='string'?{cursor:args.cursor}:{})});
      return {sessions:page.items.map(s=>({id:s.logicalSessionId,title:s.title,projectId:s.projectId,machineId:s.machineId,host:this.registry.getMachine(principal,s.machineId).name,project:s.projectAlias,available:s.actions.start.allowed,canAppend:s.actions.steer.allowed,activeTurnId:s.activeTurnId,appendUnavailableReason:s.actions.steer.allowed?null:{code:s.actions.steer.reasonCode,message:s.actions.steer.message},unavailableReason:s.actions.start.allowed?null:{code:s.actions.start.reasonCode,message:s.actions.start.message}})),nextCursor:page.nextCursor,total:page.total,instruction:"If ambiguous, ask the user. Never guess a target."};
    }
    if(args.action==='status') {
      invariant(args.sessionId===undefined||(typeof args.sessionId==='string'&&args.sessionId.trim().length>0),400,'PANEL_INPUT','sessionId 必须是非空字符串');
      invariant(args.jobId===undefined||(typeof args.jobId==='string'&&args.jobId.trim().length>0),400,'PANEL_INPUT','jobId 必须是非空字符串');
      const sessionId=typeof args.sessionId==='string'?args.sessionId:undefined;
      if(typeof args.jobId==='string') {
        const job=this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE job_id=? AND user_id=? AND workspace_id=?",args.jobId,principal.userId,principal.workspaceId);
        invariant(job && (!sessionId||job.session_id===sessionId),404,'PANEL_JOB_NOT_FOUND','该范围内没有此任务');
        return {...this.describe(principal,this.refresh(job)),scope:'job'};
      }
      if(!sessionId) {
        const tasks=this.jobs(principal,{voiceId}).map(job=>this.describe(principal,job));
        if(tasks.length>1)return {scope:'call',state:'multiple',tasks,activeCount:tasks.filter(task=>!['completed','failed','interrupted'].includes(task.state)).length,message:'不同项目可并行；追加当前任务使用 steer，查询特定任务请指定 jobId 或 sessionId'};
      }
      if(sessionId) this.registry.getSession(principal,sessionId);
      const job=this.current(principal,sessionId?{sessionId}:{voiceId});
      const sessionProgress=sessionId?this.progress.read(principal,sessionId):undefined;
      return job?{...this.describe(principal,job),scope:sessionId?'session':'call',...(sessionProgress?{sessionProgress}:{})}
        :{state:sessionProgress?.nativeTurnId?sessionProgress.state:'idle',hasCoordinatorJob:false,sessionId:sessionId??null,scope:sessionId?'session':'call',...(sessionProgress?{sessionProgress}:{}),message:sessionId?'该会话没有总控派发的任务；当前会话进度见 sessionProgress':'本次通话没有已派发任务；查询其他任务请指定 sessionId'};
    }
    invariant(args.action==='dispatch'&&typeof args.sessionId==='string'&&typeof args.prompt==='string'&&args.prompt.trim().length>0&&args.prompt.length<=20000,400,"PANEL_INPUT","目标会话和任务内容不能为空");
    const previous=this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE voice_id=? AND request_id=?",voiceId,requestId);
    if(previous) {
      invariant(previous.session_id===args.sessionId,409,'IDEMPOTENCY_KEY_REUSE','请求标识已用于其他会话');
      const payload=this.db.get<{body_json:string}>("SELECT body_json FROM command_contents WHERE command_id=? AND deleted_at IS NULL",previous.command_id);
      invariant(payload && JSON.parse(payload.body_json).prompt===args.prompt,409,'IDEMPOTENCY_KEY_REUSE','请求标识已使用且内容不同或已过期，请先查询原任务');
      return this.describe(principal,this.refresh(previous));
    }
    const session=this.registry.getSession(principal,String(args.sessionId));
    // Legacy immediate dispatch still records intent before admission; a rejected start stays a pending todo.
    todo=todo??this.memory.save(principal,{intent:args.prompt,sessionId:session.logicalSessionId,key:`dispatch:${voiceId}:${requestId}`},voiceId);
    invariant(todo.state==='pending',409,'VOICE_TODO_CANCELLED','该待办已取消，不能派发');
    if(args.todoId===undefined)invariant(todo.intent===args.prompt&&todo.session_id===session.logicalSessionId,409,'VOICE_TODO_STALE','待办已修改，请读取最新版本并确认');
    const competing=this.db.all<PanelJob>(`SELECT j.* FROM panel_voice_jobs j JOIN logical_sessions s ON s.logical_session_id=j.session_id
      WHERE j.workspace_id=? AND s.project_id=? AND j.state NOT IN ('completed','failed','interrupted')`,principal.workspaceId,session.projectId)
      .map(job=>this.refresh(job)).find(job=>!['completed','failed','interrupted'].includes(job.state));
    invariant(!competing,409,"PANEL_TASK_BUSY","该项目已有任务，请等待完成或在目标会话处理；其他项目仍可派发",competing?{jobId:competing.job_id,sessionId:competing.session_id,projectId:session.projectId}:undefined);
    invariant(session.managed&&session.actions.start.allowed,409,session.actions.start.reasonCode??"PANEL_TARGET_BUSY",session.actions.start.message??"目标会话不可执行，请选择已接管且空闲的会话");
    const lease=this.coordination.acquireLease(principal,session.logicalSessionId);
    return this.db.transaction(() => {
    // Persist the command and tracking job in one transaction, including rollback on insertion failure.
    const command=this.coordination.createCommand(principal,session.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:`panel-${voiceId}-${requestId}`.slice(0,200),payload:{prompt:args.prompt},precondition:{executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:session.projectLeaseVersion}},true).command;
    const jobId=newId('pjob');
    this.db.run("INSERT INTO panel_voice_jobs VALUES(?,?,?,?,?,?,?,NULL,'submitted',NULL,?)",jobId,principal.userId,principal.workspaceId,voiceId,requestId,session.logicalSessionId,String(command.commandId),nowIso());
    const inserted=this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE job_id=?",jobId)!;
    this.memory.link(todo!,inserted,session,args.prompt as string);
    return this.describe(principal,inserted);
    });
  }
  private shouldAutoReport(job:PanelJob,voiceId:string) {
    // An automatic spoken result belongs to the call that dispatched the work.
    // A new call may query old work explicitly, but must never replay it on connect.
    return job.voice_id===voiceId && job.reported_call_id===null && ['completed','failed','interrupted'].includes(job.state);
  }
  acknowledgeReport(voiceId:string,jobId:string) {
    this.db.run("UPDATE panel_voice_jobs SET reported_call_id=? WHERE job_id=? AND voice_id=? AND user_id=(SELECT user_id FROM panel_voice_calls WHERE voice_id=? AND state='active')",voiceId,jobId,voiceId,voiceId);
  }
  poll(principal:Principal,voiceId:string) {
    this.own(principal,voiceId);
    try {
      const tasks=this.jobs(principal,{voiceId}).map(job=>this.describe(principal,job));
      const task=tasks.find(task=>!['completed','failed','interrupted'].includes(task.state))??tasks[0]??null;
      const report=this.report(principal,voiceId);
      return {task,tasks,report,unavailable:false};
    } catch {
      this.db.run("UPDATE panel_voice_calls SET binding_json=json_set(binding_json,'$.taskStatusError','TASK_STATUS_UNAVAILABLE','$.taskStatusErrorAt',?) WHERE voice_id=?",nowIso(),voiceId);
      return {task:null,tasks:[],report:null,unavailable:true};
    }
  }
  report(principal:Principal,voiceId:string) {
    this.own(principal,voiceId);
    // Reports have their own queue: a running project must not starve completed projects.
    const job=this.db.all<PanelJob>("SELECT * FROM panel_voice_jobs WHERE user_id=? AND workspace_id=? AND voice_id=? AND reported_call_id IS NULL ORDER BY created_at,rowid",principal.userId,principal.workspaceId,voiceId)
      .map(job=>this.refresh(job)).find(job=>this.shouldAutoReport(job,voiceId));
    if(!job)return null;
    const result=this.describe(principal,job);
    if(this.shouldAutoReport(job,voiceId)) return {result,reportId:job.job_id};
    return null;
  }
}
