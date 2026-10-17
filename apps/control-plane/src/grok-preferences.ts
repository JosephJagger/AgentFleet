import type {ControlPlaneDatabase} from "./db.js";
import type {Principal} from "./auth.js";
import {invariant} from "./errors.js";
import {nowIso} from "./crypto.js";
import {mergeConfigOptions,parseConfigOptions,parseGrokSettings,supportsGrokControls,type ConfigOption,type GrokSettings} from "./grok-settings.js";

export class GrokPreferencesService {
  constructor(private readonly db:ControlPlaneDatabase){}
  private host(principal:Principal,id:string){
    const row=this.db.get<{provider:string;agent_version:string}>(`SELECT p.provider,m.agent_version FROM logical_sessions s JOIN projects p USING(project_id) JOIN machines m ON m.machine_id=s.machine_id WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL AND m.identity_state='active'`,id,principal.workspaceId);
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
  read(principal:Principal,id:string){
    this.host(principal,id);
    const row=this.db.get<{settings_json:string;revision:number}>("SELECT settings_json,revision FROM grok_preferences WHERE workspace_id=? AND logical_session_id=?",principal.workspaceId,id);
    return {settings:row?parseGrokSettings(JSON.parse(row.settings_json))??null:null,revision:row?.revision??0,options:this.options(principal,id)};
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
      allow(settings.effort,"reasoning_effort",current.settings?.effort);
      this.db.run(`INSERT INTO grok_preferences(workspace_id,logical_session_id,settings_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,logical_session_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,principal.workspaceId,id,JSON.stringify(settings),current.revision+1,nowIso());
      this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,action:"grok.preferences.save",metadata:{sessionId:id,revision:current.revision+1}});
      return this.read(principal,id);
    });
  }
}
export type {GrokSettings};
