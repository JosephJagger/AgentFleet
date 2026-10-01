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
    this.registry.getMachine(principal,machineId);
    invariant(!this.db.get("SELECT 1 FROM panel_voice_calls WHERE user_id=? AND state<>'closed'",principal.userId),409,"PANEL_VOICE_BUSY","已有面板总控通话，请先结束原通话");
    const voiceId=newId("pvoice");
    this.db.run("INSERT INTO panel_voice_calls VALUES(?,?,?,?,?,?,'starting',?)",voiceId,principal.workspaceId,principal.userId,principal.clientSessionId,machineId,JSON.stringify(binding),nowIso());
    return this.get(voiceId)!;
  }
  get(id:string) {return this.db.get<PanelCall>("SELECT * FROM panel_voice_calls WHERE voice_id=?",id);}
  pending() {return this.db.all<PanelCall>("SELECT * FROM panel_voice_calls WHERE state<>'closed'");}
  state(id:string,state:string) {this.db.run("UPDATE panel_voice_calls SET state=? WHERE voice_id=?",state,id);}
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
  current(principal:Principal) {
    const jobs=this.db.all<PanelJob>("SELECT * FROM panel_voice_jobs WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 20",principal.userId,principal.workspaceId).map(job=>this.refresh(job));
    return jobs.find(j=>!['completed','failed','interrupted'].includes(j.state))??jobs[0];
  }
  describe(principal:Principal,job:PanelJob) {
    const session=this.registry.getSession(principal,job.session_id);
    let result='';
    if(job.native_turn_id && ['completed','failed','interrupted'].includes(job.state)) {
      const rows=this.db.all<{body_json:string}>("SELECT b.body_json FROM durable_events e JOIN content_blobs b USING(payload_ref) WHERE e.logical_session_id=? AND e.native_turn_id=? AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL ORDER BY e.session_seq DESC LIMIT 30",job.session_id,job.native_turn_id);
      for(const row of rows) {const p=JSON.parse(row.body_json);const item=p.item;if(item?.type==='agentMessage'&&typeof item.text==='string'){result=item.text.slice(-6000);break;}}
    }
    return {jobId:job.job_id,sessionId:job.session_id,title:session.title,project:session.projectAlias,host:this.registry.getMachine(principal,session.machineId).name,state:job.state,result,historyLimited:!result&&['completed','failed','interrupted'].includes(job.state),link:`/sessions/${job.session_id}`};
  }
  tool(principal:Principal,voiceId:string,requestId:string,input:unknown) {
    this.own(principal,voiceId);
    invariant(typeof input==='object'&&input!==null&&!Array.isArray(input),400,"PANEL_INPUT","Invalid tool input");
    const args=input as Record<string,unknown>;
    if(args.action==='search') {
      invariant(typeof args.query==='string'&&args.query.length<=200,400,"PANEL_QUERY","请提供主机、项目或会话关键词");
      const page=this.registry.listSessionsPage(principal,{q:args.query,limit:20,managed:true,...(typeof args.cursor==='string'?{cursor:args.cursor}:{})});
      return {sessions:page.items.map(s=>({id:s.logicalSessionId,title:s.title,host:this.registry.getMachine(principal,s.machineId).name,project:s.projectAlias,available:s.actions.start.allowed})),nextCursor:page.nextCursor,total:page.total,instruction:"If ambiguous, ask the user. Never guess a target."};
    }
    const current=this.current(principal);
    if(args.action==='status') return current?this.describe(principal,current):{state:'idle',message:'没有已派发任务'};
    invariant(args.action==='dispatch'&&typeof args.sessionId==='string'&&typeof args.prompt==='string'&&args.prompt.trim().length>0&&args.prompt.length<=20000,400,"PANEL_INPUT","目标会话和任务内容不能为空");
    const previous=this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE voice_id=? AND request_id=?",voiceId,requestId);
    if(previous)return this.describe(principal,this.refresh(previous));
    invariant(!current||['completed','failed','interrupted'].includes(current.state),409,"PANEL_TASK_BUSY","总控已有任务，请先等待完成或在目标会话处理；不会重复派发");
    const session=this.registry.getSession(principal,String(args.sessionId));
    invariant(session.managed&&session.actions.start.allowed,409,"PANEL_TARGET_BUSY","目标会话不可执行，请选择已接管且空闲的会话");
    const lease=this.coordination.acquireLease(principal,session.logicalSessionId);
    return this.db.transaction(() => {
    // Persist the command and tracking job in one transaction, including rollback on insertion failure.
    const command=this.coordination.createCommand(principal,session.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:`panel-${voiceId}-${requestId}`.slice(0,200),payload:{prompt:args.prompt},precondition:{executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:session.projectLeaseVersion}},true).command;
    const jobId=newId('pjob');
    this.db.run("INSERT INTO panel_voice_jobs VALUES(?,?,?,?,?,?,?,NULL,'submitted',NULL,?)",jobId,principal.userId,principal.workspaceId,voiceId,requestId,session.logicalSessionId,String(command.commandId),nowIso());
    return this.describe(principal,this.db.get<PanelJob>("SELECT * FROM panel_voice_jobs WHERE job_id=?",jobId)!);
    });
  }
  acknowledgeReport(voiceId:string,jobId:string) {
    this.db.run("UPDATE panel_voice_jobs SET reported_call_id=? WHERE job_id=? AND user_id=(SELECT user_id FROM panel_voice_calls WHERE voice_id=?)",voiceId,jobId,voiceId);
  }
  report(principal:Principal,voiceId:string) {
    this.own(principal,voiceId);const job=this.current(principal);
    if(!job)return null;
    const result=this.describe(principal,job);
    if(['completed','failed','interrupted'].includes(job.state)&&job.reported_call_id!==voiceId) return {result,reportId:job.job_id};
    return null;
  }
}
