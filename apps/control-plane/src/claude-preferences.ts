import type {ControlPlaneDatabase} from "./db.js";
import type {Principal} from "./auth.js";
import {invariant} from "./errors.js";
import {nowIso} from "./crypto.js";
import {parseClaudeSettings, supportsClaudeControls} from "./claude-settings.js";
import {parseClaudeMetadata} from "./claude-metadata.js";

export class ClaudePreferencesService {
  constructor(private readonly db:ControlPlaneDatabase){}
  private host(principal:Principal,id:string){
    const row=this.db.get<{provider:string;agent_version:string;discovery_json:string|null}>(`SELECT p.provider,m.agent_version,m.discovery_json FROM logical_sessions s JOIN projects p USING(project_id) JOIN machines m ON m.machine_id=s.machine_id WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL AND m.identity_state='active'`,id,principal.workspaceId);
    invariant(row,404,"SESSION_NOT_FOUND","Session was not found");invariant(row.provider==="claude",400,"CLAUDE_SESSION_REQUIRED","Settings belong to a Claude Code session");return row;
  }
  read(principal:Principal,id:string){
    this.host(principal,id);
    const row=this.db.get<{settings_json:string;revision:number}>("SELECT settings_json,revision FROM claude_preferences WHERE workspace_id=? AND logical_session_id=?",principal.workspaceId,id);
    return {settings:row?parseClaudeSettings(JSON.parse(row.settings_json))!:null,revision:row?.revision??0};
  }
  write(principal:Principal,id:string,input:Record<string,unknown>){
    return this.db.transaction(()=>{
      const host=this.host(principal,id);
      invariant(Number.isSafeInteger(input.revision) && Number(input.revision)>=0,400,"INVALID_SETTINGS_REVISION","Settings revision is required");
      let settings;try{settings=parseClaudeSettings(input.settings);}catch{invariant(false,400,"CLAUDE_SETTINGS_INVALID","Unsupported Claude Code settings");}
      invariant(settings,400,"CLAUDE_SETTINGS_INVALID","Complete Claude settings are required");
      invariant(supportsClaudeControls(host.agent_version),409,"CLAUDE_AGENT_UPDATE_REQUIRED","Update the host Agent before configuring Claude Code");
      const metadata=parseClaudeMetadata(JSON.parse(host.discovery_json??"{}").agentRuntimes?.claude);
      const model=metadata.models.find(m=>m.model===settings.model);
      invariant(settings.model==="host" || model,409,"CLAUDE_MODEL_UNAVAILABLE","Select a model from the native host catalog");
      const efforts=settings.model==="host"?metadata.models[0]?.efforts:model?.efforts;
      invariant(settings.effort===undefined || efforts?.includes(settings.effort),400,"CLAUDE_EFFORT_UNAVAILABLE","Native model does not support this effort");
      if(settings.permissionMode){
        invariant(supportsClaudeControls(host.agent_version,59) && metadata.permissionModes.includes(settings.permissionMode),409,"CLAUDE_PERMISSION_MODE_UNAVAILABLE","Host does not support this permission mode");
        invariant(settings.permissionMode!=="auto" || (settings.model==="host"?metadata.models[0]:model)?.supportsAutoMode===true,400,"CLAUDE_AUTO_UNAVAILABLE","Native model does not support auto mode");
      }
      const current=this.read(principal,id);invariant(current.revision===input.revision,409,"SETTINGS_REVISION_CONFLICT","Settings changed in another browser; reload before saving");
      this.db.run(`INSERT INTO claude_preferences(workspace_id,logical_session_id,settings_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,logical_session_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,principal.workspaceId,id,JSON.stringify(settings),current.revision+1,nowIso());
      this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,action:"claude.preferences.save",metadata:{sessionId:id,revision:current.revision+1}});
      return this.read(principal,id);
    });
  }
}
