import {parseCursorOptions,parseCursorModels,parseCursorSettings,type CursorOption,type CursorModel,type CursorSettings} from './cursor-settings.js';
import {listCursorTerminalSessions,prepareCursorTerminalSession} from './cursor-sessions.js';
import {readCursorQuota,type CursorQuota} from './cursor-quota.js';
import {readGrokUsage} from './grok-usage.js';
import {grokBillingQuota,type GrokQuota} from './grok-quota.js';
import {AGENT_VERSION} from "./constants.js";
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldToIO} from 'node:timers/promises';
import {homedir} from 'node:os';
import {stat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {acpImageInput,acpImageBlocks} from './acp-images.js';
import {MAX_IMAGES,validImageUrl} from './images.js';
import {AcpConnection} from './acp-connection.js';
import {ACP_COMMANDS,detectAcp,assertAcpUnoccupied,retainReleasedCursorWorkers,type AcpExecutable} from './acp-providers.js';
import {unavailableCapabilities,type AcpProviderId,type ProviderAvailability} from './provider-catalog.js';
import {decodeProviderThread,encodeProviderThread} from './provider-identity.js';
import {AgentError} from './errors.js';
import {isRecord,nowIso,sha256,canonicalJson} from './util.js';
import type {AppServerCallbacks,ThreadHistorySnapshot,ThreadHistoryItem,DiscoveredThreadSummary,ThreadStartResult,ThreadResumeResult} from './app-server.js';
import type {ProjectRecord,ManagedThread,ApprovalRecord} from './types.js';
import type {PermissionProfile} from './permissions.js';
import type {TurnExtras} from './attachments.js';
import {inputAnswers,inputQuestions,type InputAnswers,type InputQuestion} from './user-input.js';
import {grokProgressText,grokModelOptions,parseGrokModels,acpPlanText,acpToolItem,acpUsage,grokLaunchArgs,grokSessionMeta,mergeConfigOptions,parseConfigOptions,parseGrokSettings,type ConfigOption,type GrokSettings} from './acp-updates.js';
import type {CodexSettings} from './codex-settings.js';
interface Session {id:string;cwd:string;connection:AcpConnection;items:ThreadHistoryItem[];turnId?:string;cancelled:boolean;loading:boolean;lost:boolean;imageInput:boolean;permissionMode:'default'|'always'|'auto';configOptions:ConfigOption[];cursorOptions:CursorOption[];published:Map<string,string>;completed:Set<string>;itemSizes:Map<string,number>;historyBytes:number;textPublishedAt:number;usageTotals?:import('./acp-updates.js').TokenCounts;}
interface Pending {session:Session;request:ApprovalRecord;options:Array<Record<string,unknown>>;resolve:(v:unknown)=>void;timer:NodeJS.Timeout;kind:'permission'|'question'|'plan';questions?:InputQuestion[]|undefined;nativeQuestions?:Array<Record<string,unknown>>|undefined;}
function clipUtf8(value:string,max=24000){if(Buffer.byteLength(value)<=max)return {text:value,truncated:false};let text=Buffer.from(value).subarray(0,max).toString('utf8');if(text.endsWith('\uFFFD'))text=text.slice(0,-1);return {text,truncated:true};}
const dependencies={cursorSessions:listCursorTerminalSessions,prepareCursor:prepareCursorTerminalSession,detect:detectAcp,unoccupied:assertAcpUnoccupied,readGrokUsage,readCursorQuota,connection:(o:ConstructorParameters<typeof AcpConnection>[0])=>new AcpConnection(o)};
/** New providers have their own processes and cannot fall through to Codex methods. */
export class AcpRuntime {
  availability:ProviderAvailability & {models?:import("./acp-updates.js").GrokModel[];quota?:GrokQuota;cursorQuota?:CursorQuota;cursorModels?:CursorModel[]}={installed:false,version:null,state:'missing',checkedAt:nowIso(),capabilities:unavailableCapabilities()};
  private executable:AcpExecutable|null=null;
  private executableStamp=-1;
  private readonly sessions=new Map<string,Session>();
  private readonly opening=new Map<string,{cwd:string;promise:Promise<Session>}>();
  private readonly catalog=new Map<string,DiscoveredThreadSummary>();
  private readonly pending=new Map<string,Pending>();
  private readonly owned=new Set<number>();
  private readonly deps:typeof dependencies;
  private refreshing:Promise<void>|undefined;
  private stopped=false;
  private cursorQuotaIdentity:string|undefined;
  private quotaCheckedAt=0;
  private quotaReading:Promise<void>|undefined;
  private readonly connections=new Set<AcpConnection>();
  constructor(readonly provider:AcpProviderId,private readonly callbacks:AppServerCallbacks,readonly appServerEpoch:string,overrides:Partial<typeof dependencies>={}) {this.deps={...dependencies,...overrides};}
  async start() {
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      try {
        // Re-spawning `--version` every catalog scan is wasteful; a found CLI is only re-detected when its file changes or disappears.
        const stamp=this.executable?await stat(this.executable.executable).then(f=>f.mtimeMs,()=>-1):-1;
        if(this.executable&&stamp===this.executableStamp&&stamp>=0)return;
        this.executable=await this.deps.detect(this.provider);this.executableStamp=this.executable?await stat(this.executable.executable).then(f=>f.mtimeMs,()=>-1):-1;this.availability={...this.availability,installed:Boolean(this.executable),version:this.executable?.version??null,state:this.executable?(this.availability.version===this.executable.version?this.availability.state==='missing'?'checking':this.availability.state:'checking'):'missing',checkedAt:nowIso()};}
      catch {this.availability.state='error';this.availability.error='Unable to inspect official CLI';}
    })().finally(()=>{this.refreshing=undefined;});return this.refreshing;
  }
  async stop(){if([...this.sessions.values()].some(s=>s.turnId&&!s.lost))throw new AgentError("PROVIDER_TURN_ACTIVE","Finish native work before stopping");this.stopped=true;await Promise.all([...this.sessions.keys()].map(id=>this.unsubscribeThread(id)));await Promise.all([...this.connections].map(connection=>connection.closeAndWait()));}
  private native(id:string) {const parsed=decodeProviderThread(id);if(!parsed||parsed.provider!==this.provider)throw new AgentError('PROVIDER_ID_MISMATCH','Session belongs to another provider');return parsed.nativeId;}
  private async connect(cwd:string,session?:Session,launchArgs?:string[],env?:NodeJS.ProcessEnv) {
    if(this.stopped)throw new AgentError("ACP_CLOSED","Provider runtime stopped");
    if(!this.executable)await this.start();if(this.stopped)throw new AgentError("ACP_CLOSED","Provider runtime stopped");if(!this.executable)throw new AgentError('PROVIDER_NOT_INSTALLED','Official CLI is not installed');
    let connection:AcpConnection;
    connection=this.deps.connection({executable:this.executable.executable,args:launchArgs??[...this.executable.prefix,...ACP_COMMANDS[this.provider].args],cwd,...(env?{env}:{}),
      notification:async(method,params)=>{if(session)await this.notification(session,method,params);},
      request:async(method,params)=>{if(!session)throw new AgentError('ACP_NO_SESSION','No session is authorized');return this.request(session,method,params);},
      processExited:()=>{
        this.connections.delete(connection);if(connection.pid)this.owned.delete(connection.pid);
      },
      exit:()=>{
        if(session&&!session.lost){session.lost=true;this.resolvePending(session);if(session.turnId)void this.callbacks.onThreadExit?.(session.id,this.appServerEpoch,'Native connection lost; task outcome is unknown');}
      }});
    this.connections.add(connection);connection.start();if(connection.pid)this.owned.add(connection.pid);
    try {
      const init=await connection.call('initialize',{protocolVersion:1,clientCapabilities:this.provider==='cursor'?{_meta:{parameterizedModelPicker:true}}:{},clientInfo:{name:'agentfleets',version:AGENT_VERSION}});
      if(!isRecord(init)||init.protocolVersion!==1||!isRecord(init.agentCapabilities))throw new AgentError('ACP_INCOMPATIBLE','Unsupported native protocol handshake');
      const capabilities=init.agentCapabilities,sessionCapabilities=isRecord(capabilities.sessionCapabilities)?capabilities.sessionCapabilities:{};
      const meta=isRecord(init._meta)?init._meta:{};
      const modelState=isRecord(meta.modelState)?meta.modelState:{};
      const models=this.provider==='grok'?parseGrokModels(modelState.availableModels):[];
      if(session&&models.length)session.configOptions=grokModelOptions(models,typeof modelState.currentModelId==='string'?modelState.currentModelId:undefined);
      // Invalid params cannot target a session. Only a registered native handler
      // returning InvalidParams proves this extension exists; never infer from brand.
      let steer=false;
      if(this.provider==='grok')try {await connection.call('_x.ai/interject',{},3000);}
      catch(error){steer=error instanceof AgentError && error.code==='ACP_REMOTE_ERROR' && error.message.includes('(-32602)');}
      const images=acpImageInput(this.provider,this.executable.version,init);
      if(session)session.imageInput=images;
      this.availability={...(this.availability.quota?{quota:this.availability.quota}:{}),...(this.provider==='cursor'&&this.availability.cursorQuota?{cursorQuota:this.availability.cursorQuota}:{}),...(this.provider==='cursor'&&this.availability.cursorModels?{cursorModels:this.availability.cursorModels}:{}),installed:true,version:this.executable.version,state:'ready',checkedAt:nowIso(),...(models.length?{models}:{}),capabilities:{...unavailableCapabilities(),steer,models:models.length>0||this.provider==='cursor'&&!!this.availability.cursorModels?.length,usage:(this.provider==='grok'||this.provider==='cursor')&&this.availability.capabilities.usage,images,create:true,prompt:true,cancel:true,approval:true,input:this.provider==='cursor',resume:capabilities.loadSession===true,history:capabilities.loadSession===true,discover:isRecord(sessionCapabilities.list)}};
      return connection;
    } catch(error) {connection.close();this.markFailure(error);throw error;}
  }
  /** ACP reports missing credentials as JSON-RPC -32000 (auth_required). */
  private markFailure(error:unknown) {
    const login=error instanceof AgentError&&/\(-32000\)/.test(error.message);
    if(this.provider==='cursor'){delete this.availability.cursorQuota;this.cursorQuotaIdentity=undefined;this.quotaCheckedAt=0;}
    this.availability.state=login?'login_required':'unverified';this.availability.capabilities=unavailableCapabilities();
    // Only the stable error code is surfaced, never native output that could contain credentials.
    if(error instanceof AgentError)this.availability.error=error.code;else delete this.availability.error;
  }
  async listThreads():Promise<DiscoveredThreadSummary[]> {
    await this.start();if(!this.executable){if(this.provider==='cursor')delete this.availability.cursorQuota;return [];}
    const connection=await this.connect(homedir());
    try {
      if(this.provider==='grok')await this.refreshGrokQuota(connection);
      if(this.provider==='cursor'&&Date.now()-this.quotaCheckedAt>=120000){
        this.quotaCheckedAt=Date.now();
        // Account allowance is not an ACP method; Cursor's own account service reports it for the logged-in principal.
        try {const quota=await this.deps.readCursorQuota({onIdentity:key=>{if(!key||key!==this.cursorQuotaIdentity)delete this.availability.cursorQuota;this.cursorQuotaIdentity=key;}});if(quota)this.availability.cursorQuota=quota;else delete this.availability.cursorQuota;}catch{/* Keep the timestamped prior observation; failure is never zero quota. */}
        try {const result=await connection.call('cursor/list_available_models',{},15000);const models=parseCursorModels(isRecord(result)?result.models:undefined);if(models.length){this.availability.cursorModels=models;this.availability.capabilities.models=true;}}catch{/* Optional extension: leave settings unavailable, never borrow Grok models. */}
      }
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
      if(this.provider==='cursor')for(const row of await this.deps.cursorSessions()) {
        const id=encodeProviderThread('cursor',row.id),prior=this.catalog.get(id);
        if(observed.has(id)&&prior&&resolve(prior.cwd)!==row.cwd)throw new AgentError('CURSOR_SESSION_CONFLICT','Cursor 原生目录存在冲突的会话工作区');
        observed.add(id);this.catalog.set(id,{nativeThreadId:id,cwd:row.cwd,title:row.title,titleSource:'name',executionState:this.sessions.get(id)?.turnId?'running':unoccupied?'idle':'unknown',historyMode:'legacy'});
      }
      for(const id of this.catalog.keys())if(!observed.has(id)&&!this.sessions.has(id))this.catalog.delete(id);
      return [...this.catalog.values()];
    }catch(error){if(error instanceof AgentError&&/\(-32000\)/.test(error.message))this.markFailure(error);throw error;}finally{connection.close();}
  }
  private async refreshGrokQuota(connection:AcpConnection) {
    if(this.quotaReading)return this.quotaReading;
    if(Date.now()-this.quotaCheckedAt<120000)return;
    this.quotaCheckedAt=Date.now();
    this.quotaReading=(async()=>{
      try {
        // ACP extension methods carry an underscore on the JSON-RPC wire.
        const quota=grokBillingQuota(await connection.call('_x.ai/billing',{},3000));
        if(quota)this.availability.quota=quota;
      }catch{/* Keep the timestamped prior observation; failure is never zero quota. */}
    })().finally(()=>{this.quotaReading=undefined;});
    return this.quotaReading;
  }
  private async open(id:string,cwd:string,fresh=false,settings?:GrokSettings):Promise<Session> {
    if(fresh)return this.openOwned(id,cwd,true,settings);
    const pending=this.opening.get(id);
    if(pending){if(resolve(pending.cwd)!==resolve(cwd))throw new AgentError('PROVIDER_CWD_CHANGED','Session workspace changed');return pending.promise;}
    const promise=this.openOwned(id,cwd,false,settings).finally(()=>{this.opening.delete(id);});
    this.opening.set(id,{cwd,promise});return promise;
  }
  private launchArgs(settings?:GrokSettings) {
    const command=this.provider==='grok'?grokLaunchArgs(ACP_COMMANDS.grok.args,settings):ACP_COMMANDS[this.provider].args;
    return [...(this.executable?.prefix??[]),...command];
  }
  private rememberOptions(session:Session,value:unknown) {
    if(!isRecord(value))return;
    const update=isRecord(value.update)?value.update:undefined;
    if(this.provider==='cursor'){const raw=value.configOptions??update?.configOptions;if(Array.isArray(raw))session.cursorOptions=parseCursorOptions(raw);return;}
    const list=parseConfigOptions(value.configOptions??update?.configOptions??update?.options);
    if(list.length)session.configOptions=mergeConfigOptions(session.configOptions,list);
  }
  private async openOwned(id:string,cwd:string,fresh=false,settings?:GrokSettings):Promise<Session> {
    if(!isAbsolute(cwd))throw new AgentError('PROJECT_PATH_INVALID','An absolute workspace is required');
    const existing=this.sessions.get(id);if(existing&&!existing.lost){if(resolve(existing.cwd)!==resolve(cwd))throw new AgentError('PROVIDER_CWD_CHANGED','Session workspace changed');return existing;}
    // A protocol disconnect is not proof that the OS writer has exited. Keep
    // closing children owned, and confirm their exit before opening a replacement.
    await Promise.all([...this.connections].filter(connection=>connection.closing).map(connection=>connection.closeAndWait()));
    await this.deps.unoccupied(this.provider,this.owned);
    const session={id,cwd,items:[],cancelled:false,loading:true,lost:false,permissionMode:settings?.permissionMode??'default',configOptions:[],cursorOptions:[],published:new Map<string,string>(),completed:new Set<string>(),itemSizes:new Map<string,number>(),historyBytes:0,textPublishedAt:0} as unknown as Session;
    let env:NodeJS.ProcessEnv|undefined;
    if(this.provider==='cursor'&&!fresh) {
      const row=(await this.deps.cursorSessions()).find(row=>row.id===this.native(id));
      if(row) {
        if(row.cwd!==resolve(cwd))throw new AgentError('PROVIDER_CWD_CHANGED','Cursor 会话工作区已变化');
        await this.start();
        await this.deps.prepareCursor(row,this.executable?.version??'');
        env={...process.env,CURSOR_CONFIG_DIR:row.root};
      }
    }
    session.connection=await this.connect(cwd,session,this.launchArgs(settings),env);
    try {
      if(!fresh&&!this.availability.capabilities.resume)throw new AgentError('PROVIDER_RESUME_UNAVAILABLE','Native CLI does not support session restoration');
      const meta=fresh?grokSessionMeta(this.provider==='grok'?settings:undefined):undefined;
      const result=await session.connection.call(fresh?'session/new':'session/load',{cwd,mcpServers:[],...(!fresh?{sessionId:this.native(id)}:{}),...(meta?{_meta:meta}:{})},60000);
      if(!isRecord(result))throw new AgentError('ACP_SESSION_INVALID','Invalid session response');
      if(fresh){if(typeof result.sessionId!=='string')throw new AgentError('ACP_SESSION_INVALID','Native session ID missing');session.id=encodeProviderThread(this.provider,result.sessionId);}
      else if(typeof result.sessionId==='string'&&result.sessionId!==this.native(id))throw new AgentError('PROVIDER_RESUME_MISMATCH','Native CLI restored a different session');
      this.rememberOptions(session,result);session.loading=false;this.sessions.set(session.id,session);return session;
    }catch(error){session.lost=true;session.connection.close();if(error instanceof AgentError&&/\(-32000\)/.test(error.message))this.markFailure(error);throw error;}
  }
  async createThread(project:ProjectRecord,_profile?:PermissionProfile,name?:string):Promise<ThreadStartResult> {
    const session=await this.open('',project.root,true);
    this.catalog.set(session.id,{nativeThreadId:session.id,cwd:project.root,title:name??this.provider,titleSource:'name',executionState:'idle',historyMode:'legacy'});
    return {nativeThreadId:session.id,historyMode:'legacy',policyVerified:true,rawSummary:{provider:this.provider,...(session.configOptions.length?{configOptions:session.configOptions}:{}),...(this.provider==='cursor'?{cursorOptions:session.cursorOptions}:{})}};
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
    const session=await this.open(id,sessionCwd??project.root);return {nativeThreadId:id,policyVerified:true,rawSummary:{provider:this.provider,configOptions:session.configOptions,...(this.provider==='cursor'?{cursorOptions:session.cursorOptions}:{})},history:await this.readThread(id)};
  }
  async unsubscribeThread(id:string) {
    const session=this.sessions.get(id);if(!session)return;
    if(session.turnId&&!session.lost)throw new AgentError('PROVIDER_TURN_ACTIVE','Cancel or finish the turn before releasing its writer');
    if(this.provider==='cursor'&&!session.turnId&&session.connection.pid)await retainReleasedCursorWorkers(this.owned,session.connection.pid);
    session.lost=true;this.resolvePending(session);await session.connection.closeAndWait();
    if(this.sessions.get(id)===session)this.sessions.delete(id);
  }
  private resolvePending(session:Session) {for(const [id,p] of this.pending)if(p.session===session){clearTimeout(p.timer);this.pending.delete(id);p.resolve({outcome:{outcome:'cancelled'}});void this.callbacks.onApprovalResolved(id,this.appServerEpoch).catch(()=>undefined);}}
  /** Only options the native session actually returned are written. Missing ids are left alone. */
  private async applyConfig(session:Session,settings:GrokSettings) {
    const apply=async(configId:string,value?:string)=>{
      if(!value)return;
      const option=session.configOptions.find(item=>item.id===configId);
      if(!option||!option.values.includes(value))throw new AgentError('GROK_OPTION_UNAVAILABLE','Native session does not support the selected option; reload settings');
      this.rememberOptions(session,await session.connection.call('session/set_config_option',{sessionId:this.native(session.id),configId,value}));
    };
    await apply('model',settings.model);
    await apply('reasoning_effort',settings.effort);
    if(settings.mode){
      const option=session.configOptions.find(item=>item.id==='plan'||item.id==='mode'||item.id==='task');
      if(option?.values.includes(settings.mode))await apply(option.id,settings.mode);
    }
  }
  private async applyCursorConfig(session:Session,settings:CursorSettings){
    const entries=Object.entries(settings.options??{}).sort(([a],[b])=>Number(b==='model')-Number(a==='model'));
    for(const [configId,value] of entries){
      const option=session.cursorOptions.find(o=>o.id===configId);
      if(!option?.values.some(o=>o.value===value))throw new AgentError('CURSOR_OPTION_UNAVAILABLE','Cursor 原生选项已变化，请重新读取会话配置');
      const result=await session.connection.call('session/set_config_option',{sessionId:this.native(session.id),configId,value});
      this.rememberOptions(session,result);
      if(session.cursorOptions.find(o=>o.id===configId)?.current!==value)throw new AgentError('CURSOR_CONFIG_UNCONFIRMED','Cursor 未确认配置生效，任务未发送');
    }
    if(entries.some(([id,value])=>session.cursorOptions.find(o=>o.id===id)?.current!==value))throw new AgentError('CURSOR_CONFIG_UNCONFIRMED','Cursor 原生参数互相影响，请重新选择后发送');
  }
  private async publishTool(session:Session,turnId:string,id:string,item:Record<string,unknown>) {
    if(!session.turnId||session.completed.has(id))return;
    const output=String(item.aggregatedOutput??'');
    if(!session.published.has(id)){
      await this.callbacks.onEvent({type:'item.started',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:id,payload:{item}},this.appServerEpoch);
      session.published.set(id,'');
    }
    if(output&&output!==session.published.get(id)){
      const previous=session.published.get(id)??'';
      const replace=previous.length>0&&!output.startsWith(previous);
      const delta=replace?output:output.slice(previous.length);
      const clipped=clipUtf8(delta);
      if(clipped.text)this.callbacks.onVolatile({type:'command_output.delta',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:id,payload:{delta:clipped.text,...(replace?{replace:true}:{}),...(clipped.truncated?{truncated:true}:{})}},this.appServerEpoch);
      session.published.set(id,output);
    }
    if(item.status==='completed'||item.status==='failed'||item.status==='declined'){
      await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:id,payload:{item}},this.appServerEpoch);
      session.completed.add(id);
    }
  }
  async startTurn(thread:ManagedThread,project:ProjectRecord,prompt:string,_messageId?:string,settings?:CodexSettings|GrokSettings|CursorSettings,images?:string[],extras?:TurnExtras) {
    const grok=this.provider==='grok'?parseGrokSettings(settings):undefined;
    const cursor=this.provider==='cursor'&&settings!==undefined?parseCursorSettings(settings):undefined;
    const blocked=Boolean(extras?.attachments?.length||extras?.pluginSkills?.length||extras?.outputSchema||extras?.goal);
    const settingsRejected=this.provider==='grok'?Boolean(settings)&&!grok:this.provider==='cursor'?settings!==undefined&&!cursor:Boolean(settings&&Object.keys(settings).length);
    if(blocked||settingsRejected)throw new AgentError('PROVIDER_INPUT_UNAVAILABLE','This provider currently accepts plain text with native settings only');
    const imageBlocks=acpImageBlocks(images);
    const desired=grok?.permissionMode??'default';
    const known=this.sessions.get(thread.nativeThreadId);
    if(this.provider==='grok'&&known&&!known.lost&&known.permissionMode!==desired)await this.unsubscribeThread(known.id);
    await this.deps.unoccupied(this.provider,this.owned);
    const session=await this.open(thread.nativeThreadId,thread.sessionCwd??project.root,false,grok);
    if(imageBlocks.length&&!session.imageInput)throw new AgentError('AGENT_IMAGE_UNSUPPORTED','当前智能体未提供可用的图片输入能力；图片未发送，请检查原生版本和模型');
    if(session.turnId&&!session.lost)throw new AgentError('PROVIDER_TURN_ACTIVE','Native turn is already running');
    if(this.provider==='grok'&&grok)await this.applyConfig(session,grok);
    if(this.provider==='cursor'){
      if(session.turnId&&!session.lost)throw new AgentError('PROVIDER_TURN_ACTIVE','Native turn is already running');
      if(cursor)await this.applyCursorConfig(session,cursor);
      session.permissionMode=cursor?.permissionMode??'default';
    }
    const startedAt=Date.now();
    const turnId=randomUUID();session.turnId=turnId;session.cancelled=false;
    const itemId=`${turnId}:user`,item={id:itemId,type:'userMessage',content:[{type:'text',text:prompt},...(images??[]).map(url=>({type:'image',url}))]};
    session.items.push({nativeTurnId:turnId,nativeItemId:itemId,item});this.accountItem(session,session.items.at(-1)!);
    await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:itemId,payload:{item}},this.appServerEpoch);
    setImmediate(()=>{void session.connection.call('session/prompt',{sessionId:this.native(session.id),prompt:[{type:'text',text:prompt},...imageBlocks]},24*3600000).then(async result=>{
      if(session.lost||session.turnId!==turnId)return;
      if(!isRecord(result)||typeof result.stopReason!=='string')throw new AgentError('ACP_RESULT_INVALID','Missing native completion evidence');
      let usage=this.provider==='grok'&&this.executable?await this.deps.readGrokUsage(this.executable,this.native(session.id),startedAt):acpUsage(result);
      if(session.lost||session.turnId!==turnId)return;
      if(usage&&this.provider==='cursor'){
        const meta=isRecord(result._meta)?result._meta:{};
        const raw=isRecord(result.usage)?result.usage:isRecord(meta.usage)?meta.usage:{};
        if(!isRecord(raw.total)){
          const total={...usage.usage.last};
          for(const key of Object.keys(total) as Array<keyof typeof total>)total[key]+=session.usageTotals?.[key]??0;
          usage=Object.values(total).every(Number.isSafeInteger)?{usage:{total,last:usage.usage.last}}:undefined;
        }
        if(usage)session.usageTotals=usage.usage.total;
      }
      if(usage&&(this.provider==='grok'||this.provider==='cursor'))this.availability.capabilities.usage=true;
      if(usage)await this.callbacks.onEvent({type:'thread.usage',nativeThreadId:session.id,nativeTurnId:turnId,payload:usage},this.appServerEpoch);
      await this.flush(session,turnId);delete session.turnId;this.resolvePending(session);
      await this.callbacks.onEvent({type:'turn.completed',nativeThreadId:session.id,nativeTurnId:turnId,payload:{turn:{id:turnId,status:result.stopReason==='end_turn'?'completed':result.stopReason==='cancelled'?'interrupted':'failed'},stopReason:result.stopReason,...(session.configOptions.length?{configOptions:session.configOptions}:{}),...(this.provider==='cursor'?{cursorOptions:session.cursorOptions}:{})}},this.appServerEpoch);
    }).catch(async()=>{if(!session.lost){session.lost=true;this.resolvePending(session);session.connection.close();await this.callbacks.onThreadExit?.(session.id,this.appServerEpoch,'Native result unknown; request was not replayed');}});});
    return {nativeTurnId:turnId,status:'inProgress'};
  }
  async readTurnOutcome(id:string,turnId:string) {
    this.native(id);
    const session=this.sessions.get(id);
    return session?.turnId===turnId&&!session.lost ? {cwd:session.cwd,status:'inProgress'} : null;
  }
  async steerTurn(thread:ManagedThread,turnId:string,prompt:string,messageId?:string,images?:string[],extras?:TurnExtras) {
    this.native(thread.nativeThreadId);
    if(this.provider!=='grok'||!this.availability.capabilities.steer)throw new AgentError('AGENT_CAPABILITY_UNAVAILABLE','Native running-turn input is unavailable; use the queue');
    const session=this.sessions.get(thread.nativeThreadId);
    if(!session||session.lost||session.cancelled||session.turnId!==turnId)throw new AgentError('TURN_PRECONDITION_FAILED','Native turn changed; additional input was not sent');
    if(extras?.attachments?.length||extras?.pluginSkills?.length||extras?.outputSchema||extras?.goal)throw new AgentError('AGENT_INPUT_UNSUPPORTED','Native interjection does not support these inputs');
    const blocks=acpImageBlocks(images);
    // Image prompt support alone does not prove image interjection support.
    if(blocks.length&&(!session.imageInput||!/^grok 1\.0\.62(?:\s|$)/.test(this.executable?.version??'')))throw new AgentError('AGENT_IMAGE_UNSUPPORTED','当前原生版本尚未验证追加图片，请将文字和图片一起加入队列');
    let response:unknown;
    try {
      response=await session.connection.call('_x.ai/interject',{sessionId:this.native(session.id),text:prompt,interjectionId:messageId??randomUUID(),...(blocks.length?{content:[{type:'text',text:prompt},...blocks]}:{})},10000);
    } catch(error) {
      // A missing handler proves no input was accepted. Transport/timeouts remain unknown.
      if(error instanceof AgentError && error.code==='ACP_REMOTE_ERROR' && error.message.includes('(-32601)'))throw new AgentError('AGENT_CAPABILITY_UNAVAILABLE','Native interjection rejected: method unavailable; use the queue');
      throw error;
    }
    const receipt=isRecord(response)&&isRecord(response.result)?response.result:response;
    if(!isRecord(receipt)||receipt.status!=='queued')throw new AgentError('ACP_RESULT_INVALID','Native interjection outcome is unknown; do not resend automatically');
    // "queued" means accepted into the active native turn, not another Fleet turn.
    return {nativeTurnId:turnId,status:'queued'};
  }
  async interruptTurn(id:string,turnId:string) {
    const session=this.sessions.get(id);if(!session||session.lost||session.turnId!==turnId)throw new AgentError('PROVIDER_TURN_CHANGED','Native turn is no longer current');
    session.cancelled=true;session.connection.notify('session/cancel',{sessionId:this.native(id)});this.resolvePending(session);return {requested:true};
  }
  private accountItem(session:Session,entry:ThreadHistoryItem) {
    const size=Buffer.byteLength(JSON.stringify(entry));
    session.historyBytes+=size-(session.itemSizes.get(entry.nativeItemId)??0);
    session.itemSizes.set(entry.nativeItemId,size);
    if(session.items.length>10000||session.historyBytes>16*1024*1024)throw new AgentError('ACP_HISTORY_LIMIT','Native history exceeds supported snapshot limit');
  }
  private async finishText(session:Session,nextType?:string) {
    const last=session.items.at(-1);
    if(!session.turnId||!last||last.nativeTurnId!==session.turnId||!['agentMessage','reasoning'].includes(String(last.item?.type))||last.item?.type===nextType||session.completed.has(last.nativeItemId))return;
    await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:session.turnId,nativeItemId:last.nativeItemId,payload:{item:last.item}},this.appServerEpoch);
    session.completed.add(last.nativeItemId);
  }
  private async notification(session:Session,method:string,params:Record<string,unknown>) {
    if(session.lost||!isRecord(params.update))return;
    const extension=this.provider==='grok'&&method==='_x.ai/session_notification';
    if(method!=='session/update'&&!extension)return;
    if(session.id&&params.sessionId!==this.native(session.id))throw new AgentError('ACP_SESSION_MISMATCH','Event belongs to a different native session');
    const update=params.update,kind=update.sessionUpdate;
    if(extension){
      if(!session.turnId||session.loading)return;
      const text=grokProgressText(update);
      if(!text)return;
      await this.finishText(session);
      const id=`${session.turnId}:notice:${session.items.length}`;
      const item={id,type:'reasoning',text};
      const entry={nativeTurnId:session.turnId,nativeItemId:id,item};
      session.items.push(entry);this.accountItem(session,entry);
      await this.callbacks.onEvent({type:'item.completed',nativeThreadId:session.id,nativeTurnId:session.turnId,nativeItemId:id,payload:{item}},this.appServerEpoch);
      session.completed.add(id);return;
    }
    if(kind==='config_option_update'){this.rememberOptions(session,params);return;}
    const turnId=session.turnId??'history';
    const textType=kind==='agent_message_chunk'?'agentMessage':kind==='agent_thought_chunk'?'reasoning':undefined;
    if(['agent_message_chunk','agent_thought_chunk','user_message_chunk','tool_call','tool_call_update','plan'].includes(String(kind)))await this.finishText(session,textType);
    let changed:ThreadHistoryItem|undefined;
    if(kind==='user_message_chunk'&&isRecord(update.content)&&update.content.type==='image') {
      const url=typeof update.content.data==='string'&&typeof update.content.mimeType==='string'?`data:${update.content.mimeType};base64,${update.content.data}`:'';
      let last=session.items.at(-1);
      if(!last||last.nativeTurnId!==turnId||last.item?.type!=='userMessage') {
        const id=`${turnId}:${session.items.length}`;last={nativeTurnId:turnId,nativeItemId:id,item:{id,type:'userMessage',content:[{type:'text',text:''}]}};session.items.push(last);
      }
      changed=last;
      const content=last.item!.content as Array<{type:string;url?:string;text?:string}>;
      if(validImageUrl(url)) {
        if(!content.some(c=>c.type==='image'&&c.url===url)&&content.filter(c=>c.type==='image').length<MAX_IMAGES)content.push({type:'image',url});
      }else content[0]!.text+='[原生历史图片未同步：格式或大小超出面板限制]';
    } else if(['agent_message_chunk','user_message_chunk','agent_thought_chunk'].includes(String(kind))&&isRecord(update.content)&&update.content.type==='text'&&typeof update.content.text==='string') {
      const type=kind==='user_message_chunk'?'userMessage':kind==='agent_thought_chunk'?'reasoning':'agentMessage';
      let last=session.items.at(-1);
      if(!last||last.nativeTurnId!==turnId||last.item?.type!==type||session.completed.has(last.nativeItemId)) {
        const id=`${turnId}:${session.items.length}`;last={nativeTurnId:turnId,nativeItemId:id,item:{id,type,...(type==='userMessage'?{content:[{type:'text',text:''}]}:{text:''})}};session.items.push(last);
      }
      changed=last;
      const item=last.item!;
      if(type==='userMessage'){const content=item.content as Array<{text:string}>;content[0]!.text+=update.content.text;}else item.text=String(item.text)+update.content.text;
      if(session.turnId&&type==='reasoning'&&(Date.now()-session.textPublishedAt>=250)){
        session.textPublishedAt=Date.now();
        await this.callbacks.onEvent({type:'item.started',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:last.nativeItemId,payload:{item}},this.appServerEpoch);
      }
      if(session.turnId&&type==='agentMessage')this.callbacks.onVolatile({type:'agent_message.delta',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:last.nativeItemId,payload:{delta:update.content.text}},this.appServerEpoch);
    } else if((kind==='tool_call'||kind==='tool_call_update')&&typeof update.toolCallId==='string') {
      const id=`${turnId}:tool:${update.toolCallId}`;let entry=session.items.find(i=>i.nativeItemId===id);
      const item={...acpToolItem(update,entry?.item??undefined),cwd:session.cwd,id};
      if(!entry){entry={nativeTurnId:turnId,nativeItemId:id,item};session.items.push(entry);}else entry.item=item;
      changed=entry;
      if(session.turnId)await this.publishTool(session,session.turnId,id,item);
    } else if(kind==='plan') {
      const id=`${turnId}:plan`;const item={id,type:'plan',text:acpPlanText(update)};
      let entry=session.items.find(i=>i.nativeItemId===id);
      if(!entry){entry={nativeTurnId:turnId,nativeItemId:id,item};session.items.push(entry);}else entry.item={...entry.item,...item};
      changed=entry;
      if(session.turnId&&!session.completed.has(id))await this.callbacks.onEvent({type:'item.started',nativeThreadId:session.id,nativeTurnId:session.turnId,nativeItemId:id,payload:{item:entry.item}},this.appServerEpoch);
    }
    if(changed)this.accountItem(session,changed);
  }
  private async flush(session:Session,turnId:string) {
    const pending=session.items.filter(i=>i.nativeTurnId===turnId&&i.item?.type!=='userMessage'&&!session.completed.has(i.nativeItemId));
    // One durable transaction per chunk. A resolved await does not let the heartbeat timer run.
    for(let index=0;index<pending.length;index+=32) {
      const chunk=pending.slice(index,index+32);
      const events=chunk.map(entry=>({type:'item.completed',nativeThreadId:session.id,nativeTurnId:turnId,nativeItemId:entry.nativeItemId,payload:{item:entry.item}}));
      if(this.callbacks.onEvents) await this.callbacks.onEvents(events,this.appServerEpoch);
      else for(const event of events) await this.callbacks.onEvent(event,this.appServerEpoch);
      for(const entry of chunk) session.completed.add(entry.nativeItemId);
      await yieldToIO();
    }
  }
  private async request(session:Session,method:string,params:Record<string,unknown>):Promise<unknown> {
    if(session.loading||session.lost||!session.turnId||(params.sessionId !== undefined ? params.sessionId!==this.native(session.id) : !method.startsWith('cursor/') || this.provider!=='cursor'))return {outcome:{outcome:'cancelled'}};
    const kind=method==='session/request_permission'?'permission':method==='cursor/ask_question'?'question':method==='cursor/create_plan'?'plan':null;
    if(!kind)throw new AgentError('ACP_METHOD_UNAVAILABLE','Native client request is unsupported');
    const thread=this.callbacks.findManagedThread(session.id);if(!thread)throw new AgentError('ACP_UNMANAGED','Session no longer managed');
    const options=Array.isArray(params.options)?params.options.filter(isRecord):[];
    if(this.provider==='cursor'&&kind==='permission'&&session.permissionMode==='always'){
      const once=options.find(o=>o.kind==='allow_once'&&typeof o.optionId==='string');
      if(once)return {outcome:{outcome:'selected',optionId:once.optionId}};
    }
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
