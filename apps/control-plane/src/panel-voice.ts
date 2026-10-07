import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { CoordinationService } from "./coordination.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { newId, nowIso } from "./crypto.js";

export interface PanelCall { voice_id:string; workspace_id:string; user_id:string; owner_id:string; machine_id:string; binding_json:string; state:string; created_at:string; }
interface PanelJob { job_id:string; user_id:string; workspace_id:string; voice_id:string; request_id:string; session_id:string; command_id:string; native_turn_id:string|null; state:string; reported_call_id:string|null; created_at:string; }
/** Global coordinator only routes work. Existing session commands enforce permissions and project exclusivity. */
export class PanelVoiceService {
  constructor(private db:ControlPlaneDatabase,private registry:RegistryService,private coordination:CoordinationService) {}
  start(principal:Principal,machineId:string,binding:Record<string,unknown>) {
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
    const code=typeof reason==='string'&&['USER_HANGUP','PAGE_HIDDEN','CLIENT_DISPOSED','SIGNAL_CLOSED','NATIVE_CLOSED','HOST_DISCONNECTED','OWNER_EXPIRED','SERVER_ERROR'].includes(reason)?reason:'SERVER_ERROR';
    this.db.run("UPDATE panel_voice_calls SET binding_json=json_set(binding_json,'$.closeReason',?,'$.closeRequestedAt',?) WHERE voice_id=? AND json_extract(binding_json,'$.closeReason') IS NULL",code,nowIso(),id);
  }
  closeOrphans() {this.db.run("UPDATE panel_voice_calls SET state='closed' WHERE state<>'closed'");}
  private own(principal:Principal,voiceId:string) {
    const call=this.get(voiceId);
    invariant(call && call.workspace_id===principal.workspaceId && call.user_id===principal.userId && call.owner_id===principal.clientSessionId && call.state==='active',403,"PANEL_VOICE_OWNER","总控通话已结束或无权操作");
    this.registry.getMachine(principal,call.machine_id);
    return call;
  }
  private refresh(job:PanelJob):PanelJob {
    if(["completed","failed","interrupted"].includes(job.state))return job;
    const command=this.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",job.command_id);
    let state=job.state, turnId=job.native_turn_id;
    if(!turnId) turnId=this.db.get<{native_turn_id:string}>("SELECT native_turn_id FROM durable_events e JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.type='turn.started' AND json_extract(b.body_json,'$.commandId')=? ORDER BY session_seq LIMIT 1",job.session_id,job.command_id)?.native_turn_id??null;
    // Command acknowledgments still identify the turn when project content sync is disabled,
    // or a very fast task completed before the synthetic turn.started event was emitted.
    if(!turnId) turnId=this.db.get<{native_turn_id:string}>("SELECT COALESCE(json_extract(detail_json,'$.response.nativeTurnId'),json_extract(detail_json,'$.nativeTurnId')) AS native_turn_id FROM command_lifecycle WHERE command_id=? AND native_turn_id IS NOT NULL ORDER BY lifecycle_id DESC LIMIT 1",job.command_id)?.native_turn_id??null;
    if(turnId) {
      const end=this.db.get<{body_json:string|null}>("SELECT b.body_json FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type='turn.completed' ORDER BY session_seq DESC LIMIT 1",job.session_id,turnId);
      if(end) {const body=JSON.parse(end.body_json??'{}');state=['completed','failed','interrupted'].includes(body.turn?.status)?body.turn.status:'unknown';}
      else state='running';
    } else if(command?.state==='invalidated' || command?.state==='expired' || command?.state==='cancelled') state='failed';
    else if(command?.state==='unknown') state='unknown';
    else if(command?.state==='applied') {
      const failure=this.db.get("SELECT 1 FROM command_lifecycle WHERE command_id=? AND (json_extract(detail_json,'$.ok')=0 OR json_extract(detail_json,'$.error') IS NOT NULL OR json_extract(detail_json,'$.code') IS NOT NULL)",job.command_id);
      if(failure) state='failed';
    }
    this.db.run("UPDATE panel_voice_jobs SET state=?,native_turn_id=? WHERE job_id=?",state,turnId,job.job_id);
    return {...job,state,native_turn_id:turnId};
  }
  current(principal:Principal, scope?: {sessionId?:string;voiceId?:string}) {
    const filter=scope?.sessionId ? " AND session_id=?" : scope?.voiceId ? " AND voice_id=?" : "";
    const value=scope?.sessionId??scope?.voiceId;
    const jobs=this.db.all<PanelJob>(`SELECT * FROM panel_voice_jobs WHERE user_id=? AND workspace_id=?${filter} ORDER BY created_at DESC,rowid DESC LIMIT 20`,principal.userId,principal.workspaceId,...(value?[value]:[])).map(job=>this.refresh(job));
    return jobs.find(j=>!['completed','failed','interrupted'].includes(j.state))??jobs[0];
  }
  describe(principal:Principal,job:PanelJob) {
    const session=this.registry.getSession(principal,job.session_id);
    let result='';
    const terminal=['completed','failed','interrupted'].includes(job.state);
    const command=this.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",job.command_id);
    const failure=this.db.get<{detail_json:string}>(`SELECT detail_json FROM command_lifecycle WHERE command_id=?
      AND (json_extract(detail_json,'$.error') IS NOT NULL OR json_extract(detail_json,'$.code') IS NOT NULL)
      ORDER BY lifecycle_id DESC LIMIT 1`,job.command_id);
    const detail=JSON.parse(failure?.detail_json??'{}');
    const end=job.native_turn_id?this.db.get<{body_json:string|null}>("SELECT b.body_json FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type='turn.completed' AND e.payload_state='present' AND b.deleted_at IS NULL ORDER BY session_seq DESC LIMIT 1",job.session_id,job.native_turn_id):undefined;
    const nativeError=JSON.parse(end?.body_json??'{}').turn?.error;
    const source=nativeError??detail.error??detail;
    const error=(job.state==='failed'||job.state==='interrupted')&&typeof source.code==='string'
      ? {code:source.code,message:typeof source.message==='string'?source.message:'任务失败，原因未提供'}
      : (job.state==='failed'||job.state==='interrupted')&&typeof source.message==='string'
        ? {code:'TASK_FAILED',message:source.message} : null;
    // Missing turn evidence is not proof that execution never began (timeouts/unknown outcomes).
    const executionStarted=job.native_turn_id?true:error?.code==='MACHINE_DRAINING'?false:null;
    const historyLimited=Boolean(job.native_turn_id&&terminal&&this.db.get(`SELECT 1 FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref)
      WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type IN ('item.completed','turn.completed')
      AND (e.payload_state<>'present' OR b.payload_ref IS NULL OR b.deleted_at IS NOT NULL) LIMIT 1`,job.session_id,job.native_turn_id));
    if(job.native_turn_id && ['completed','failed','interrupted'].includes(job.state)) {
      const rows=this.db.all<{body_json:string}>("SELECT b.body_json FROM durable_events e JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL ORDER BY e.session_seq DESC LIMIT 30",job.session_id,job.native_turn_id);
      for(const row of rows) {const p=JSON.parse(row.body_json);const item=p.item;if(item?.type==='agentMessage'&&typeof item.text==='string'){result=item.text.slice(-6000);break;}}
    }
    return {jobId:job.job_id,commandId:job.command_id,nativeTurnId:job.native_turn_id,sessionId:job.session_id,title:session.title,project:session.projectAlias,host:this.registry.getMachine(principal,session.machineId).name,state:job.state,result,historyLimited,error,executionStarted,commandState:command?.state??null,resultStatus:result?'available':executionStarted===false?'not_started':historyLimited?'history_unavailable':terminal?'no_output':'pending',link:`/sessions/${job.session_id}`};
  }
  tool(principal:Principal,voiceId:string,requestId:string,input:unknown) {
    this.own(principal,voiceId);
    invariant(typeof input==='object'&&input!==null&&!Array.isArray(input),400,"PANEL_INPUT","Invalid tool input");
    const args=input as Record<string,unknown>;
    if(args.action==='search') {
      invariant(typeof args.query==='string'&&args.query.length<=200,400,"PANEL_QUERY","请提供主机、项目或会话关键词");
      const page=this.registry.listSessionsPage(principal,{q:args.query,limit:20,managed:true,...(typeof args.cursor==='string'?{cursor:args.cursor}:{})});
      return {sessions:page.items.map(s=>({id:s.logicalSessionId,title:s.title,host:this.registry.getMachine(principal,s.machineId).name,project:s.projectAlias,available:s.actions.start.allowed,unavailableReason:s.actions.start.allowed?null:{code:s.actions.start.reasonCode,message:s.actions.start.message}})),nextCursor:page.nextCursor,total:page.total,instruction:"If ambiguous, ask the user. Never guess a target."};
    }
    if(args.action==='status') {
      invariant(args.sessionId===undefined||(typeof args.sessionId==='string'&&args.sessionId.trim().length>0),400,'PANEL_INPUT','sessionId 必须是非空字符串');
      const sessionId=typeof args.sessionId==='string'?args.sessionId:undefined;
      if(sessionId) this.registry.getSession(principal,sessionId);
      const job=this.current(principal,sessionId?{sessionId}:{voiceId});
      return job?{...this.describe(principal,job),scope:sessionId?'session':'call'}:{state:'idle',sessionId:sessionId??null,scope:sessionId?'session':'call',message:sessionId?'该会话没有总控派发的任务':'本次通话没有已派发任务；查询其他任务请指定 sessionId'};
    }
    const current=this.current(principal);
    invariant(args.action==='dispatch'&&typeof args.sessionId==='string'&&typeof args.prompt==='string'&&args.prompt.trim().length>0&&args.prompt.length<=20000,400,"PANEL_INPUT","目标会话和任务内容不能为空");
    const previous=this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE voice_id=? AND request_id=?",voiceId,requestId);
    if(previous)return this.describe(principal,this.refresh(previous));
    invariant(!current||['completed','failed','interrupted'].includes(current.state),409,"PANEL_TASK_BUSY","总控已有任务，请先等待完成或在目标会话处理；不会重复派发",current?{jobId:current.job_id,sessionId:current.session_id}:undefined);
    const session=this.registry.getSession(principal,String(args.sessionId));
    invariant(session.managed&&session.actions.start.allowed,409,session.actions.start.reasonCode??"PANEL_TARGET_BUSY",session.actions.start.message??"目标会话不可执行，请选择已接管且空闲的会话");
    const lease=this.coordination.acquireLease(principal,session.logicalSessionId);
    return this.db.transaction(() => {
    // Persist the command and tracking job in one transaction, including rollback on insertion failure.
    const command=this.coordination.createCommand(principal,session.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:`panel-${voiceId}-${requestId}`.slice(0,200),payload:{prompt:args.prompt},precondition:{executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:session.projectLeaseVersion}},true).command;
    const jobId=newId('pjob');
    this.db.run("INSERT INTO panel_voice_jobs VALUES(?,?,?,?,?,?,?,NULL,'submitted',NULL,?)",jobId,principal.userId,principal.workspaceId,voiceId,requestId,session.logicalSessionId,String(command.commandId),nowIso());
    return this.describe(principal,this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE job_id=?",jobId)!);
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
      const job=this.current(principal,{voiceId});
      const task=job?this.describe(principal,job):null;
      const report=job&&task&&this.shouldAutoReport(job,voiceId)?{reportId:job.job_id,result:task}:null;
      return {task,report,unavailable:false};
    } catch {
      this.db.run("UPDATE panel_voice_calls SET binding_json=json_set(binding_json,'$.taskStatusError','TASK_STATUS_UNAVAILABLE','$.taskStatusErrorAt',?) WHERE voice_id=?",nowIso(),voiceId);
      return {task:null,report:null,unavailable:true};
    }
  }
  report(principal:Principal,voiceId:string) {
    this.own(principal,voiceId);const job=this.current(principal,{voiceId});
    if(!job)return null;
    const result=this.describe(principal,job);
    if(this.shouldAutoReport(job,voiceId)) return {result,reportId:job.job_id};
    return null;
  }
}
