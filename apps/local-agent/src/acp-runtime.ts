import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {isAbsolute,resolve} from 'node:path';
import {AcpConnection} from './acp-connection.js';
import {ACP_COMMANDS,detectAcp,assertAcpUnoccupied,type AcpExecutable} from './acp-providers.js';
import {unavailableCapabilities,type AcpProviderId,type ProviderAvailability} from './provider-catalog.js';
import {decodeProviderThread,encodeProviderThread} from './provider-identity.js';
import {AgentError} from './errors.js';
import {isRecord,nowIso,sha256,canonicalJson} from './util.js';
import type {AppServerCallbacks,ThreadHistorySnapshot,ThreadHistoryItem,DiscoveredThreadSummary,ThreadStartResult,ThreadResumeResult} from './app-server.js';
import type {ProjectRecord,ManagedThread,ApprovalRecord} from './types.js';
import type {CodexSettings} from './codex-settings.js';
import type {PermissionProfile} from './permissions.js';
import type {TurnExtras} from './attachments.js';
import {inputAnswers,inputQuestions,type InputAnswers,type InputQuestion} from './user-input.js';
interface Session {id:string;cwd:string;connection:AcpConnection;items:ThreadHistoryItem[];turnId?:string;cancelled:boolean;loading:boolean;lost:boolean;}
interface Pending {session:Session;request:ApprovalRecord;options:Array<Record<string,unknown>>;resolve:(v:unknown)=>void;timer:NodeJS.Timeout;kind:'permission'|'question'|'plan';questions?:InputQuestion[]|undefined;nativeQuestions?:Array<Record<string,unknown>>|undefined;}
const dependencies={detect:detectAcp,unoccupied:assertAcpUnoccupied,connection:(o:ConstructorParameters<typeof AcpConnection>[0])=>new AcpConnection(o)};
/** New providers have their own processes and cannot fall through to Codex methods. */
export class AcpRuntime {
  availability:ProviderAvailability={installed:false,version:null,state:'missing',checkedAt:nowIso(),capabilities:unavailableCapabilities()};
  private executable:AcpExecutable|null=null;
  private readonly sessions=new Map<string,Session>();
  private readonly opening=new Map<string,{cwd:string;promise:Promise<Session>}>();
  private readonly catalog=new Map<string,DiscoveredThreadSummary>();
  private readonly pending=new Map<string,Pending>();
  private readonly owned=new Set<number>();
  private readonly deps:typeof dependencies;
  private refreshing:Promise<void>|undefined;
  private stopped=false;
  private readonly connections=new Set<AcpConnection>();
  constructor(readonly provider:AcpProviderId,private readonly callbacks:AppServerCallbacks,readonly appServerEpoch:string,overrides:Partial<typeof dependencies>={}) {this.deps={...dependencies,...overrides};}
  async start() {
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      try {this.executable=await this.deps.detect(this.provider);this.availability={...this.availability,installed:Boolean(this.executable),version:this.executable?.version??null,state:this.executable?(this.availability.version===this.executable.version?this.availability.state==='missing'?'checking':this.availability.state:'checking'):'missing',checkedAt:nowIso()};}
      catch {this.availability.state='error';this.availability.error='Unable to inspect official CLI';}
    })().finally(()=>{this.refreshing=undefined;});return this.refreshing;
  }
  async stop(){if([...this.sessions.values()].some(s=>s.turnId&&!s.lost))throw new AgentError("PROVIDER_TURN_ACTIVE","Finish native work before stopping");this.stopped=true;await Promise.all([...this.sessions.keys()].map(id=>this.unsubscribeThread(id)));for(const connection of this.connections)connection.close();}
  private native(id:string) {const parsed=decodeProviderThread(id);if(!parsed||parsed.provider!==this.provider)throw new AgentError('PROVIDER_ID_MISMATCH','Session belongs to another provider');return parsed.nativeId;}
  private async connect(cwd:string,session?:Session) {
    if(this.stopped)throw new AgentError("ACP_CLOSED","Provider runtime stopped");
    if(!this.executable)await this.start();if(this.stopped)throw new AgentError("ACP_CLOSED","Provider runtime stopped");if(!this.executable)throw new AgentError('PROVIDER_NOT_INSTALLED','Official CLI is not installed');
    let connection:AcpConnection;
    connection=this.deps.connection({executable:this.executable.executable,args:[...this.executable.prefix,...ACP_COMMANDS[this.provider].args],cwd,
      notification:async(method,params)=>{if(session)await this.notification(session,method,params);},
      request:async(method,params)=>{if(!session)throw new AgentError('ACP_NO_SESSION','No session is authorized');return this.request(session,method,params);},
      exit:()=>{
        this.connections.delete(connection);if(connection.pid)this.owned.delete(connection.pid);
        if(session&&!session.lost){session.lost=true;this.resolvePending(session);if(session.turnId)void this.callbacks.onThreadExit?.(session.id,this.appServerEpoch,'Native connection lost; task outcome is unknown');}
      }});
    this.connections.add(connection);connection.start();if(connection.pid)this.owned.add(connection.pid);
    try {
      const init=await connection.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentfleets',version:'0.30.107'}});
      if(!isRecord(init)||init.protocolVersion!==1||!isRecord(init.agentCapabilities))throw new AgentError('ACP_INCOMPATIBLE','Unsupported native protocol handshake');
      const capabilities=init.agentCapabilities,sessionCapabilities=isRecord(capabilities.sessionCapabilities)?capabilities.sessionCapabilities:{};
      this.availability={installed:true,version:this.executable.version,state:'ready',checkedAt:nowIso(),capabilities:{...unavailableCapabilities(),create:true,prompt:true,cancel:true,approval:true,input:this.provider==='cursor',resume:capabilities.loadSession===true,history:capabilities.loadSession===true,discover:isRecord(sessionCapabilities.list)}};
      return connection;
    } catch(error) {connection.close();this.markFailure(error);throw error;}
  }
  /** ACP reports missing credentials as JSON-RPC -32000 (auth_required). */
  private markFailure(error:unknown) {
    const login=error instanceof AgentError&&/\(-32000\)/.test(error.message);
    this.availability.state=login?'login_required':'unverified';this.availability.capabilities=unavailableCapabilities();
  }
  async listThreads():Promise<DiscoveredThreadSummary[]> {
    await this.start();if(!this.executable)return [];
    const connection=await this.connect(homedir());
    try {
      if(!this.availability.capabilities.discover)return [...this.catalog.values()];
      let unoccupied=false;try {await this.deps.unoccupied(this.provider,this.owned);unoccupied=true;}catch{/* Unknown ownership is never idle. */}
      const seen=new Set<string>();const observed=new Set<string>();let cursor:string|undefined;let complete=false;
      for(let page=0;page<20;page++) {
        const result=await connection.call('session/list',{...(cursor?{cursor}:{})});
        if(!isRecord(result)||!Array.isArray(result.sessions))throw new AgentError('ACP_CATALOG_INVALID','Invalid session catalog');
        for(const row of result.sessions)if(isRecord(row)&&typeof row.sessionId==='string'&&typeof row.cwd==='string'&&isAbsolute(row.cwd)) {
          const id=encodeProviderThread(this.provider,row.sessionId);observed.add(id);this.catalog.set(id,{nativeThreadId:id,cwd:row.cwd,title:typeof row.title==='string'?row.title.slice(0,200):this.provider,executionState:this.sessions.get(id)?.turnId?'running':unoccupied?'idle':'unknown',historyMode:'legacy'});
        }
        if(typeof result.nextCursor!=='string'||!result.nextCursor){complete=true;break;}
        if(seen.has(result.nextCursor))throw new AgentError('ACP_CURSOR_REPEATED','Native session cursor repeated');seen.add(result.nextCursor);cursor=result.nextCursor;
      }
      if(!complete)throw new AgentError('ACP_CATALOG_LIMIT','Native catalog exceeds supported page limit');
      for(const id of this.catalog.keys())if(!observed.has(id)&&!this.sessions.has(id))this.catalog.delete(id);
      return [...this.catalog.values()];
    }catch(error){if(error instanceof AgentError&&/\(-32000\)/.test(error.message))this.markFailure(error);throw error;}finally{connection.close();}
  }
  private async open(id:string,cwd:string,fresh=false):Promise<Session> {
    if(fresh)return this.openOwned(id,cwd,true);
    const pending=this.opening.get(id);
    if(pending){if(resolve(pending.cwd)!==resolve(cwd))throw new AgentError('PROVIDER_CWD_CHANGED','Session workspace changed');return pending.promise;}
    const promise=this.openOwned(id,cwd).finally(()=>{this.opening.delete(id);});
    this.opening.set(id,{cwd,promise});return promise;
  }
  private async openOwned(id:string,cwd:string,fresh=false):Promise<Session> {
    if(!isAbsolute(cwd))throw new AgentError('PROJECT_PATH_INVALID','An absolute workspace is required');
    const existing=this.sessions.get(id);if(existing&&!existing.lost){if(resolve(existing.cwd)!==resolve(cwd))throw new AgentError('PROVIDER_CWD_CHANGED','Session workspace changed');return existing;}
    await this.deps.unoccupied(this.provider,this.owned);
    const session={id,cwd,items:[],cancelled:false,loading:true,lost:false} as unknown as Session;
    session.connection=await this.connect(cwd,session);
    try {
      if(!fresh&&!this.availability.capabilities.resume)throw new AgentError('PROVIDER_RESUME_UNAVAILABLE','Native CLI does not support session restoration');
      const result=await session.connection.call(fresh?'session/new':'session/load',{cwd,mcpServers:[],...(!fresh?{sessionId:this.native(id)}:{})},60000);
      if(!isRecord(result))throw new AgentError('ACP_SESSION_INVALID','Invalid session response');
      if(fresh){if(typeof result.sessionId!=='string')throw new AgentError('ACP_SESSION_INVALID','Native session ID missing');session.id=encodeProviderThread(this.provider,result.sessionId);}
      else if(typeof result.sessionId==='string'&&result.sessionId!==this.native(id))throw new AgentError('PROVIDER_RESUME_MISMATCH','Native CLI restored a different session');
      session.loading=false;this.sessions.set(session.id,session);return session;
    }catch(error){session.lost=true;session.connection.close();if(error instanceof AgentError&&/\(-32000\)/.test(error.message))this.markFailure(error);throw error;}
  }
  async createThread(project:ProjectRecord,_profile?:PermissionProfile,name?:string):Promise<ThreadStartResult> {
    const session=await this.open('',project.root,true);
    this.catalog.set(session.id,{nativeThreadId:session.id,cwd:project.root,title:name??this.provider,titleSource:'name',executionState:'idle',historyMode:'legacy'});
    return {nativeThreadId:session.id,historyMode:'legacy',policyVerified:true,rawSummary:{provider:this.provider}};
  }
  async readThread(id:string,metadataOnly=false):Promise<ThreadHistorySnapshot> {
    this.native(id);const managed=this.callbacks.findManagedThread(id),row=this.catalog.get(id);
    const cwd=row?.cwd??managed?.sessionCwd??this.callbacks.findProject(managed?.projectId??'')?.root;
    if(!cwd)throw new AgentError('PROVIDER_SESSION_MISSING','Native session is not in the known catalog');
    let session=this.sessions.get(id);
    if(!metadataOnly&&(!session||session.lost))session=await this.open(id,cwd);
    return {nativeThreadId:id,cwd,historyMode:'legacy',executionState:session?.turnId?'running':session&&!session.lost?'idle':'unknown',updatedAt:null,items:metadataOnly?[]:session?.items??[]};
  }
  async resumeThread(id:string,project:ProjectRecord,sessionCwd?:string,_profile?:PermissionProfile):Promise<ThreadResumeResult> {
    await this.open(id,sessionCwd??project.root);return {nativeThreadId:id,policyVerified:true,rawSummary:{provider:this.provider},history:await this.readThread(id)};
  }
  async unsubscribeThread(id:string) {
    const session=this.sessions.get(id);if(!session)return;
    if(session.turnId&&!session.lost)throw new AgentError('PROVIDER_TURN_ACTIVE','Cancel or finish the turn before releasing its writer');
    session.lost=true;this.resolvePending(session);session.connection.close();this.sessions.delete(id);
  }
  private resolvePending(session:Session) {for(const [id,p] of this.pending)if(p.session===session){clearTimeout(p.timer);this.pending.delete(id);p.resolve({outcome:{outcome:'cancelled'}});void this.callbacks.onApprovalResolved(id,this.appServerEpoch).catch(()=>undefined);}}
  async startTurn(thread:ManagedThread,project:ProjectRecord,prompt:string,_messageId?:string,settings?:CodexSettings,images?:string[],extras?:TurnExtras) {
    if(images?.length||extras?.attachments?.length||extras?.pluginSkills?.length||extras?.outputSchema||extras?.goal||settings&&Object.keys(settings).length)throw new AgentError('PROVIDER_INPUT_UNAVAILABLE','This provider currently accepts plain text with native settings only');
    await this.deps.unoccupied(this.provider,this.owned);
    const session=await this.open(thread.nativeThreadId,thread.sessionCwd??project.root);
    if(session.turnId&&!session.lost)throw new AgentError('PROVIDER_TURN_ACTIVE','Native turn is already running');
    const turnId=randomUUID();session.turnId=turnId;session.cancelled=false;
    const itemId=`${turnId}:user`,item={id:itemId,type:'userMessage',content:[{type:'text',text:prompt}]};
    session.items.push({nativeTurnId:turnId,nativeItemId:itemId,item});
    await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:itemId,payload:{item}},this.appServerEpoch);
    setImmediate(()=>{void session.connection.call('session/prompt',{sessionId:this.native(session.id),prompt:[{type:'text',text:prompt}]},24*3600000).then(async result=>{
      if(session.lost||session.turnId!==turnId)return;
      if(!isRecord(result)||typeof result.stopReason!=='string')throw new AgentError('ACP_RESULT_INVALID','Missing native completion evidence');
      await this.flush(session,turnId);delete session.turnId;this.resolvePending(session);
      await this.callbacks.onEvent({type:'turn.completed',nativeThreadId:session.id,nativeTurnId:turnId,payload:{turn:{id:turnId,status:result.stopReason==='end_turn'?'completed':result.stopReason==='cancelled'?'interrupted':'failed'},stopReason:result.stopReason}},this.appServerEpoch);
    }).catch(async()=>{if(!session.lost){session.lost=true;this.resolvePending(session);session.connection.close();await this.callbacks.onThreadExit?.(session.id,this.appServerEpoch,'Native result unknown; request was not replayed');}});});
    return {nativeTurnId:turnId,status:'inProgress'};
  }
  async readTurnOutcome(id:string,turnId:string) {
    this.native(id);
    const session=this.sessions.get(id);
    return session?.turnId===turnId&&!session.lost ? {cwd:session.cwd,status:'inProgress'} : null;
  }
  async steerTurn(){throw new AgentError('AGENT_CAPABILITY_UNAVAILABLE','Running-turn steering has not been verified for this provider');}
  async interruptTurn(id:string,turnId:string) {
    const session=this.sessions.get(id);if(!session||session.lost||session.turnId!==turnId)throw new AgentError('PROVIDER_TURN_CHANGED','Native turn is no longer current');
    session.cancelled=true;session.connection.notify('session/cancel',{sessionId:this.native(id)});this.resolvePending(session);return {requested:true};
  }
  private async notification(session:Session,method:string,params:Record<string,unknown>) {
    if(session.lost||method!=='session/update'||!isRecord(params.update))return;
    if(session.id&&params.sessionId!==this.native(session.id))throw new AgentError('ACP_SESSION_MISMATCH','Event belongs to a different native session');
    const update=params.update,kind=update.sessionUpdate;
    const turnId=session.turnId??'history';
    if(['agent_message_chunk','user_message_chunk','agent_thought_chunk'].includes(String(kind))&&isRecord(update.content)&&update.content.type==='text'&&typeof update.content.text==='string') {
      const type=kind==='user_message_chunk'?'userMessage':kind==='agent_thought_chunk'?'reasoning':'agentMessage';
      let last=session.items.at(-1);
      if(!last||last.nativeTurnId!==turnId||last.item?.type!==type) {
        const id=`${turnId}:${session.items.length}`;last={nativeTurnId:turnId,nativeItemId:id,item:{id,type,...(type==='userMessage'?{content:[{type:'text',text:''}]}:{text:''})}};session.items.push(last);
      }
      const item=last.item!;
      if(type==='userMessage'){const content=item.content as Array<{text:string}>;content[0]!.text+=update.content.text;}else item.text=String(item.text)+update.content.text;
      if(session.turnId&&type==='agentMessage')this.callbacks.onVolatile({type:'agent_message.delta',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:last.nativeItemId,payload:{delta:update.content.text}},this.appServerEpoch);
    } else if((kind==='tool_call'||kind==='tool_call_update')&&typeof update.toolCallId==='string') {
      const id=`${turnId}:tool:${update.toolCallId}`;let entry=session.items.find(i=>i.nativeItemId===id);
      if(!entry){entry={nativeTurnId:turnId,nativeItemId:id,item:{id,type:'mcpToolCall',server:this.provider}};session.items.push(entry);}
      entry.item={...entry.item,tool:update.title??entry.item?.tool??'Tool',status:update.status??entry.item?.status??'inProgress',...(update.rawInput!==undefined?{arguments:update.rawInput}:{}),...(update.rawOutput!==undefined?{result:update.rawOutput}:{})};
    }
    if(session.items.length>10000||Buffer.byteLength(JSON.stringify(session.items))>16*1024*1024)throw new AgentError('ACP_HISTORY_LIMIT','Native history exceeds supported snapshot limit');
  }
  private async flush(session:Session,turnId:string) {for(const entry of session.items.filter(i=>i.nativeTurnId===turnId&&i.item?.type!=='userMessage'))await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:entry.nativeItemId,payload:{item:entry.item}},this.appServerEpoch);}
  private async request(session:Session,method:string,params:Record<string,unknown>):Promise<unknown> {
    if(session.loading||session.lost||!session.turnId||(params.sessionId !== undefined ? params.sessionId!==this.native(session.id) : !method.startsWith('cursor/') || this.provider!=='cursor'))return {outcome:{outcome:'cancelled'}};
    const kind=method==='session/request_permission'?'permission':method==='cursor/ask_question'?'question':method==='cursor/create_plan'?'plan':null;
    if(!kind)throw new AgentError('ACP_METHOD_UNAVAILABLE','Native client request is unsupported');
    const thread=this.callbacks.findManagedThread(session.id);if(!thread)throw new AgentError('ACP_UNMANAGED','Session no longer managed');
    const options=Array.isArray(params.options)?params.options.filter(isRecord):[];
    let questions:InputQuestion[]|undefined;
    let nativeQuestions:Array<Record<string,unknown>>|undefined;
    if(kind==='question') {
      if(this.provider!=='cursor'||!Array.isArray(params.questions)||!params.questions.every(isRecord)) throw new AgentError('ACP_QUESTION_INVALID','Unsupported native question');
      nativeQuestions=params.questions;
      if(nativeQuestions.some(q=>q.isSecret===true||q.allowMultiple===true||!Array.isArray(q.options)||q.options.some(o=>!isRecord(o)||typeof o.id!=='string'||typeof o.label!=='string')||new Set(q.options.map(o=>(o as Record<string,unknown>).label)).size!==q.options.length))throw new AgentError('ACP_QUESTION_INVALID','Unsupported multi-selection or ambiguous options');
      questions=inputQuestions(nativeQuestions.map(q=>({id:q.id,header:typeof params.title==='string'?params.title:'Cursor',question:q.prompt,isOther:false,options:(q.options as Array<Record<string,unknown>>).map(o=>({label:o.label,description:''}))})));
    }
    const id=randomUUID();const timestamp=nowIso();
    const approval:ApprovalRecord={approvalId:id,nativeRequestId:id,appServerEpoch:this.appServerEpoch,nativeThreadId:session.id,nativeTurnId:session.turnId,projectId:thread.projectId,method:kind==='question'?'item/tool/requestUserInput':'item/commandExecution/requestApproval',actionHash:sha256(canonicalJson(params)),params:kind==='question'?{kind:'user_input',isBlocking:true,questions}:{reason:JSON.stringify(kind==='plan'?params:params.toolCall??{}).slice(0,10000)},state:'pending',createdAt:timestamp,updatedAt:timestamp,expiresAt:new Date(Date.now()+600000).toISOString()};
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);resolve({outcome:{outcome:'cancelled'}});void this.callbacks.onApprovalResolved(id,this.appServerEpoch).catch(()=>undefined);},600000);timer.unref();this.pending.set(id,{session,request:approval,options,resolve,timer,kind,questions,nativeQuestions});void this.callbacks.onApproval(approval).catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});});
  }
  async respondApproval(approval:ApprovalRecord,decision:'accept'|'decline'|'cancel') {
    const p=this.pending.get(String(approval.nativeRequestId));if(!p||p.request.actionHash!==approval.actionHash||p.session.turnId!==approval.nativeTurnId||approval.appServerEpoch!==this.appServerEpoch)throw new AgentError('APPROVAL_STALE','Native approval is no longer current');
    let result:unknown={outcome:{outcome:'cancelled'}};
    if(p.kind==='plan')result={outcome:{outcome:decision==='accept'?'accepted':decision==='decline'?'rejected':'cancelled'}};
    else if(p.kind==='permission'&&decision!=='cancel') {
      const option=p.options.find(o=>o.kind===(decision==='accept'?'allow_once':'reject_once'));
      if(option&&typeof option.optionId==='string')result={outcome:{outcome:'selected',optionId:option.optionId}};
      else if(decision==='accept')throw new AgentError('APPROVAL_SCOPE_UNAVAILABLE','Native CLI did not offer one-time permission');
    }
    clearTimeout(p.timer);this.pending.delete(approval.approvalId);p.resolve(result);await this.callbacks.onApprovalResolved(approval.nativeRequestId,this.appServerEpoch);
  }
  async respondInput(approval:ApprovalRecord,answers:InputAnswers){
    const p=this.pending.get(String(approval.nativeRequestId));
    if(!p||p.kind!=='question'||!p.questions||!p.nativeQuestions||p.session.lost||p.session.turnId!==approval.nativeTurnId||p.request.actionHash!==approval.actionHash||approval.appServerEpoch!==this.appServerEpoch)throw new AgentError('APPROVAL_STALE','Native question is no longer current');
    const validated=inputAnswers(answers,p.questions);
    const selected=p.nativeQuestions.map(q=>{
      const id=String(q.id);const options=q.options as Array<Record<string,unknown>>;
      const option=options.find(o=>o.label===validated[id]!.answers[0]);
      if(!option)throw new AgentError('INPUT_ANSWERS_INVALID','Select a native option');
      return {questionId:id,selectedOptionIds:[option.id]};
    });
    clearTimeout(p.timer);this.pending.delete(String(approval.nativeRequestId));
    p.resolve({outcome:{outcome:'answered',answers:selected}});
    await this.callbacks.onApprovalResolved(approval.nativeRequestId,this.appServerEpoch);
  }
}
