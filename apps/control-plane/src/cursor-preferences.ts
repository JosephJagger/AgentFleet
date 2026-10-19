import type {ControlPlaneDatabase} from './db.js';
import type {Principal} from './auth.js';
import {invariant} from './errors.js';
import {nowIso} from './crypto.js';
import {parseCursorModels,parseCursorOptions,parseCursorSettings,supportsCursorSettings} from './cursor-settings.js';

export class CursorPreferencesService {
  constructor(private readonly db:ControlPlaneDatabase){}
  private host(principal:Principal,id:string){
    const host=this.db.get<{provider:string;agent_version:string;discovery_json:string|null}>(`SELECT p.provider,m.agent_version,m.discovery_json FROM logical_sessions s JOIN projects p USING(project_id) JOIN machines m ON m.machine_id=s.machine_id WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL AND m.identity_state='active'`,id,principal.workspaceId);
    invariant(host,404,'SESSION_NOT_FOUND','Session was not found');
    invariant(host.provider==='cursor',400,'CURSOR_SESSION_REQUIRED','Settings belong to a Cursor session');return host;
  }
  /** Native configuration metadata is separate from expiring conversation bodies. */
  record(sessionId:string,payload:unknown,occurredAt:string){
    if(!payload||typeof payload!=='object')return;
    const p=payload as Record<string,unknown>,policy=p.effectivePolicy as Record<string,unknown>|undefined;
    const raw=p.cursorOptions??policy?.cursorOptions;
    if(!Array.isArray(raw))return;
    const options=parseCursorOptions(raw);
    const session=this.db.get<{workspace_id:string}>(`SELECT s.workspace_id FROM logical_sessions s JOIN projects p USING(project_id) WHERE logical_session_id=? AND p.provider='cursor' AND s.deleted_at IS NULL`,sessionId);
    if(!session)return;
    this.db.run(`INSERT INTO cursor_native_options(workspace_id,logical_session_id,options_json,observed_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,logical_session_id) DO UPDATE SET options_json=excluded.options_json,observed_at=excluded.observed_at WHERE excluded.observed_at>=cursor_native_options.observed_at`,session.workspace_id,sessionId,JSON.stringify(options),occurredAt);
  }
  read(principal:Principal,id:string){
    const host=this.host(principal,id);
    const models=parseCursorModels(JSON.parse(host.discovery_json??'{}').agentRuntimes?.cursor?.cursorModels);
    const saved=this.db.get<{settings_json:string;revision:number}>('SELECT settings_json,revision FROM cursor_preferences WHERE workspace_id=? AND logical_session_id=?',principal.workspaceId,id);
    const native=this.db.get<{options_json:string;observed_at:string}>('SELECT options_json,observed_at FROM cursor_native_options WHERE workspace_id=? AND logical_session_id=?',principal.workspaceId,id);
    const options=parseCursorOptions(native?JSON.parse(native.options_json):[]);
    if(models.length&&!options.some(o=>o.id==='model'))options.push({id:'model',name:'Model',category:'model',values:models.map(m=>({value:m.value,name:m.name}))});
    return {settings:saved?parseCursorSettings(JSON.parse(saved.settings_json))??null:null,revision:saved?.revision??0,options,models,observedAt:native?.observed_at??null,supported:supportsCursorSettings(host.agent_version)};
  }
  validate(principal:Principal,id:string,input:unknown){
    const state=this.read(principal,id),settings=parseCursorSettings(input);
    invariant(state.supported,409,'CURSOR_AGENT_UPDATE_REQUIRED','Cursor 会话配置需要 Agent 0.30.127 或更新版本');
    invariant(settings,400,'CURSOR_SETTINGS_INVALID','Unsupported Cursor settings');
    const selected=settings.options?.model;
    const model=state.models.find(m=>m.value===selected);
    const changingModel=!!selected&&selected!==state.options.find(o=>o.id==='model')?.current;
    const options=changingModel?state.options.filter(o=>o.id==='model'||o.id==='mode').concat(model?.configOptions??[]):state.options;
    for(const [id,value] of Object.entries(settings.options??{})){
      const option=options.find(o=>o.id===id);
      invariant(option?.values.some(v=>v.value===value),409,'CURSOR_OPTION_UNAVAILABLE','Cursor 原生选项已变化，请重新读取会话配置');
    }
    return settings;
  }
  write(principal:Principal,id:string,input:Record<string,unknown>){
    return this.db.transaction(()=>{
      const settings=this.validate(principal,id,input.settings),current=this.read(principal,id);
      invariant(Number.isSafeInteger(input.revision)&&input.revision===current.revision,409,'SETTINGS_REVISION_CONFLICT','Settings changed in another browser; reload before saving');
      this.db.run(`INSERT INTO cursor_preferences(workspace_id,logical_session_id,settings_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,logical_session_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,principal.workspaceId,id,JSON.stringify(settings),current.revision+1,nowIso());
      this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,action:'cursor.preferences.save',metadata:{sessionId:id,revision:current.revision+1}});
      return this.read(principal,id);
    });
  }
}
