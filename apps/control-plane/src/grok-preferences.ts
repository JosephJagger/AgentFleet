import type {ControlPlaneDatabase} from "./db.js";
import type {Principal} from "./auth.js";
import {invariant} from "./errors.js";
import {nowIso} from "./crypto.js";
import {parseGrokModels,grokModelOptions,mergeConfigOptions,parseConfigOptions,parseGrokSettings,supportsGrokControls,type ConfigOption,type GrokSettings} from "./grok-settings.js";

export class GrokPreferencesService {
  constructor(private readonly db:ControlPlaneDatabase){}
  private host(principal:Principal,id:string){
    const row=this.db.get<{has_native:number;provider:string;agent_version:string;discovery_json:string|null}>(`SELECT p.provider,m.agent_version,m.discovery_json,EXISTS(SELECT 1 FROM execution_segments e WHERE e.logical_session_id=s.logical_session_id AND e.native_thread_id IS NOT NULL) AS has_native FROM logical_sessions s JOIN projects p USING(project_id) JOIN machines m ON m.machine_id=s.machine_id WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL AND m.identity_state='active'`,id,principal.workspaceId);
    invariant(row,404,"SESSION_NOT_FOUND","Session was not found");
    invariant(row.provider==="grok",400,"GROK_SESSION_REQUIRED","Settings belong to a Grok Build session");
    return row;
  }
  /** Latest native configOptions carried on thread start or turn completion. */
  options(principal:Principal,id:string):ConfigOption[] {
    const rows=this.db.all<{type:string;body_json:string|null}>(`SELECT e.type,
      CASE WHEN e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN b.body_json ELSE NULL END AS body_json
      FROM durable_events e LEFT JOIN content_blobs b USING(payload_ref)
      WHERE e.logical_session_id=? AND e.workspace_id=? AND e.type IN ('thread.started','turn.completed')
      ORDER BY e.session_seq DESC LIMIT 8`,id,principal.workspaceId);
    let options:ConfigOption[]=[];
    for(const row of [...rows].reverse()){
      if(!row.body_json)continue;
      let payload:unknown;try{payload=JSON.parse(row.body_json);}catch{continue;}
      if(!payload||typeof payload!=="object")continue;
      const record=payload as Record<string,unknown>;
      const policy=record.effectivePolicy&&typeof record.effectivePolicy==="object"?record.effectivePolicy as Record<string,unknown>:undefined;
      const list=parseConfigOptions(row.type==="thread.started"?policy?.configOptions:record.configOptions);
      if(list.length)options=mergeConfigOptions(options,list);
    }
    return options;
  }
  private observed(principal:Principal,id:string){
    const row=this.db.get<{body_json:string;occurred_at:string}>(`SELECT b.body_json,e.occurred_at FROM durable_events e JOIN content_blobs b USING(payload_ref)
      WHERE e.logical_session_id=? AND e.workspace_id=? AND e.type='turn.completed' AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY e.session_seq DESC LIMIT 1`,id,principal.workspaceId);
    if(!row)return;
    let value:unknown;try{value=JSON.parse(row.body_json)?.grokState;}catch{return;}
    if(!value||typeof value!=='object')return;
    const state=value as Record<string,unknown>;
    return {observedAt:row.occurred_at,...(state.mode==='plan'||state.mode==='default'?{mode:state.mode}:{}),...(['default','always','auto'].includes(String(state.permissionRequested))&&state.permissionStatus==='requested'?{permissionRequested:String(state.permissionRequested),permissionStatus:'requested'}:{})};
  }
  read(principal:Principal,id:string){
    const host=this.host(principal,id);
    const native=JSON.parse(host.discovery_json??"{}").agentRuntimes?.grok;
    const models=parseGrokModels(native?.models);
    const commands=Array.isArray(native?.commands)?native.commands.filter((c:unknown):c is {name:string;description:string;hint?:string}=>!!c&&typeof c==='object'&&typeof (c as {name:unknown}).name==='string'&&/^[a-z0-9-]{1,80}$/.test((c as {name:string}).name)).slice(0,80).map((c:{name:string;description:string;hint?:string})=>({name:c.name,description:String(c.description??'').slice(0,500),hint:String(c.hint??'').slice(0,200)})):[];
    const row=this.db.get<{settings_json:string;revision:number}>("SELECT settings_json,revision FROM grok_preferences WHERE workspace_id=? AND logical_session_id=?",principal.workspaceId,id);
    const observed=this.observed(principal,id);
    return {...(observed?{observed}:{}),...(native?.nativeManagement===true?{nativeManagement:true,commands,xSearchSupported:Array.isArray(native?.grokTools)&&['x_keyword_search','x_semantic_search'].every(k=>native.grokTools.includes(k)),canConfigureStartup:!host.has_native,grokControls:{planMode:native.grokControls?.planMode===true,permissionSync:native.grokControls?.permissionSync===true}}:{}),settings:row?parseGrokSettings(JSON.parse(row.settings_json))??null:null,revision:row?.revision??0,options:mergeConfigOptions(this.options(principal,id),grokModelOptions(models)),...(models.length?{models}:{})};
  }
  write(principal:Principal,id:string,input:Record<string,unknown>){
    return this.db.transaction(()=>{
      const host=this.host(principal,id);
      invariant(Number.isSafeInteger(input.revision)&&Number(input.revision)>=0,400,"INVALID_SETTINGS_REVISION","Settings revision is required");
      const settings=parseGrokSettings(input.settings);
      invariant(settings,400,"GROK_SETTINGS_INVALID","Unsupported Grok Build settings");
      invariant(supportsGrokControls(host.agent_version),409,"GROK_AGENT_UPDATE_REQUIRED","Update the host Agent before configuring Grok Build");
      const current=this.read(principal,id);
      invariant(current.revision===input.revision,409,"SETTINGS_REVISION_CONFLICT","Settings changed in another browser; reload before saving");
      const allow=(value:string|undefined,optionId:string,stored?:string)=>{
        if(!value)return;
        const option=current.options.find(item=>item.id===optionId);
        if(!option||option.values.length===0)return;
        invariant(option.values.includes(value)||value===stored,409,"GROK_OPTION_UNAVAILABLE","Select a value reported by the native session");
      };
      allow(settings.model,"model",current.settings?.model);
      if(settings.mode!==undefined)invariant(current.grokControls?.planMode,409,'GROK_MODE_UNAVAILABLE','当前主机未提供可验证的 Grok 模式切换，请更新连接服务和原生运行时');
      if(settings.permissionMode==='auto'||settings.permissionMode==='default')invariant(current.grokControls?.permissionSync,409,'GROK_PERMISSION_UNAVAILABLE','当前主机未验证恢复后的 Grok 权限同步，请更新原生运行时或沿用原生设置');
      for(const key of ['rules','systemPromptOverride','agentProfile'] as const){
        if(settings[key])invariant(current.nativeManagement,409,'GROK_AGENT_UPDATE_REQUIRED','Update the host before using native startup settings');
        if(host.has_native)invariant(settings[key]===current.settings?.[key],409,'GROK_STARTUP_LOCKED','Startup settings can only be changed before creating the native session');
      }
      if(settings.xSearch!==undefined)invariant(current.xSearchSupported,409,'GROK_OPTION_UNAVAILABLE','Native X search filters are unavailable');
      if(settings.contextWindow){
        const model=settings.model??current.options.find(o=>o.id==='model')?.current;
        invariant(current.models?.find(m=>m.id===model)?.contextWindows?.includes(settings.contextWindow),409,'GROK_OPTION_UNAVAILABLE','Select a context window reported for this model');
        invariant(current.nativeManagement,409,'GROK_AGENT_UPDATE_REQUIRED','Update the host to apply extended Grok settings');
      }
      if(settings.model&&current.models?.length) {
        const model=current.models.find(model=>model.id===settings.model);
        invariant(model,409,"GROK_OPTION_UNAVAILABLE","Select a model reported by the host");
        invariant(!settings.effort||model.efforts.includes(settings.effort),409,"GROK_OPTION_UNAVAILABLE","Native model does not support this effort");
      } else allow(settings.effort,"reasoning_effort",current.settings?.effort);
      this.db.run(`INSERT INTO grok_preferences(workspace_id,logical_session_id,settings_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,logical_session_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,principal.workspaceId,id,JSON.stringify(settings),current.revision+1,nowIso());
      this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,action:"grok.preferences.save",metadata:{sessionId:id,revision:current.revision+1}});
      return this.read(principal,id);
    });
  }
}
export type {GrokSettings};
