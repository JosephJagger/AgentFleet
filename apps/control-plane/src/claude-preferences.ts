import type {ControlPlaneDatabase} from "./db.js";
import type {Principal} from "./auth.js";
import {invariant} from "./errors.js";
import {nowIso} from "./crypto.js";
import {parseClaudeSettings, supportsClaudeControls} from "./claude-settings.js";
import {parseClaudeMetadata} from "./claude-metadata.js";

export class ClaudePreferencesService {
  constructor(private readonly db:ControlPlaneDatabase){}
  /** Called only after a successful host receipt, never on an optimistic click. */
  completePlanExit(commandId:string){
    const row=this.db.get<{workspace_id:string;logical_session_id:string;decided_at:string}>(
      `SELECT s.workspace_id,s.logical_session_id,a.decided_at FROM approvals a
       JOIN commands c ON c.command_id=a.decision_command_id
       JOIN command_projection cp ON cp.command_id=c.command_id
       JOIN logical_sessions s ON s.logical_session_id=a.logical_session_id
       JOIN projects p ON p.project_id=s.project_id
       WHERE c.command_id=? AND c.type='approval.decide_once' AND cp.state='applied'
         AND a.state='approved' AND a.decided_at IS NOT NULL
         AND c.logical_session_id=s.logical_session_id AND c.workspace_id=s.workspace_id
         AND s.deleted_at IS NULL AND p.provider='claude'
         AND json_extract(a.context_json,'$.action.toolName')='ExitPlanMode'
         AND EXISTS(SELECT 1 FROM command_lifecycle l WHERE l.command_id=c.command_id AND l.state='applied'
           AND json_extract(l.detail_json,'$.response.delivered')=1
           AND json_extract(l.detail_json,'$.response.decision')='approve'
           AND json_extract(l.detail_json,'$.response.approvalId')=a.approval_id)`,commandId);
    if(!row)return false;
    const updated=this.db.get<{revision:number}>(
      `UPDATE claude_preferences SET settings_json=json_set(settings_json,'$.mode','default'),
       revision=revision+1,updated_at=? WHERE workspace_id=? AND logical_session_id=?
       AND updated_at<=? AND json_extract(settings_json,'$.mode')='plan' RETURNING revision`,
      nowIso(),row.workspace_id,row.logical_session_id,row.decided_at);
    if(!updated)return false;
    this.db.audit({workspaceId:row.workspace_id,logicalSessionId:row.logical_session_id,
      action:"claude.preferences.plan_completed",metadata:{commandId,revision:updated.revision}});
    return true;
  }
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
