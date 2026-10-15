import type {ControlPlaneDatabase} from './db.js';
import type {RegistryService} from './registry.js';
import type {Principal} from './auth.js';
import {invariant} from './errors.js';
import {pageCursor,parsePageCursor} from './pagination.js';

/** Identity metadata only. A directory entry is neither native execution proof nor authorization. */
export class VoiceDirectory {
 constructor(private db:ControlPlaneDatabase,private registry:RegistryService){}
 read(principal:Principal,input:Record<string,unknown>={}) {
  const text=(key:string)=>{const v=input[key];invariant(v===undefined||typeof v==='string'&&v.length<=200,400,'DIRECTORY_FILTER','目录筛选必须是至多 200 字的文字');return (v as string|undefined)?.trim()||'';};
  const query=text('query'),host=text('host'),project=text('project'),sessionName=text('sessionName'),machineId=text('machineId'),projectId=text('projectId'),provider=text('provider');
  invariant(!provider||['codex','claude'].includes(provider),400,'DIRECTORY_FILTER','provider 必须是 codex 或 claude');
  invariant(input.currentTask===undefined||typeof input.currentTask==='boolean',400,'DIRECTORY_FILTER','currentTask 必须是布尔值');
  const status=input.currentTask===true?'running':text('directoryStatus')||'all';
  invariant(['all','active','online','managed','running'].includes(status),400,'DIRECTORY_FILTER','目录状态无效');
  invariant(input.cursor===undefined||typeof input.cursor==='string',400,'INVALID_CURSOR','目录游标无效');
  const scope=JSON.stringify(['voice-directory',principal.workspaceId,query,host,project,sessionName,machineId,projectId,provider,status]);
  const cursor=parsePageCursor(input.cursor as string|undefined,scope);
  // Sweep before querying, then use the same freshness rule for host and session summaries.
  const machines=this.registry.listMachines(principal);
  const at=new Date(),cutoff=new Date(at.getTime()-90000).toISOString();
  const online="m.reachability='online' AND m.last_heartbeat_at>=?";
  const live=`(${online} AND s.reachability='live')`;
  const running=`(${live} AND s.active_turn_id IS NOT NULL AND s.execution_state='running')`;
  const where=["s.workspace_id=?","m.identity_state='active'","s.deleted_at IS NULL"];
  const params:Array<string|number>=[principal.workspaceId];
  const match=(fields:string[],value:string)=>{if(value){where.push('('+fields.map(f=>`instr(lower(coalesce(${f},'')),lower(?))>0`).join(' OR ')+')');params.push(...fields.map(()=>value));}};
  for(const term of query.split(/\s+/).filter(Boolean))match(['s.title','p.alias','p.canonical_root','m.name','m.display_alias','s.session_cwd','p.provider'],term);
  match(['m.name','m.display_alias'],host);match(['p.alias','p.canonical_root'],project);match(['s.title'],sessionName);
  for(const [field,value] of [['s.machine_id',machineId],['s.project_id',projectId],['p.provider',provider]])if(value){where.push(`${field}=?`);params.push(value!);}
  if(status==='managed')where.push('s.managed=1');
  if(status==='online'){where.push(`(${online})`);params.push(cutoff);}
  if(status==='running'){where.push(running);params.push(cutoff);}
  if(status==='active'){where.push(`(s.managed=1 OR ${running})`);params.push(cutoff);}
  const from='FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id JOIN projects p ON p.project_id=s.project_id';
  const total=this.db.get<{n:number}>(`SELECT count(*) n ${from} WHERE ${where.join(' AND ')}`,...params)!.n;
  if(cursor){where.push('s.logical_session_id>?');params.push(cursor[1]!);}
  const ids=this.db.all<{id:string}>(`SELECT s.logical_session_id id ${from} WHERE ${where.join(' AND ')} ORDER BY s.logical_session_id LIMIT 21`,...params);
  const sessions=ids.slice(0,20).map(({id})=>{
   const s=this.registry.getSession(principal,id),m=machines.find(m=>m.machineId===s.machineId)!;
   const fresh=m.reachability==='online'&&Boolean(m.lastHeartbeatAt&&m.lastHeartbeatAt>=cutoff)&&s.reachability==='live';
   return {id,title:s.title,provider:s.provider,machineId:s.machineId,host:m.name,projectId:s.projectId,project:s.projectAlias,
    managed:s.managed,executionState:s.executionState,activeTurnId:s.activeTurnId,reachability:s.reachability,
    freshness:fresh?'live':'stale',source:'host_session_projection',hostHeartbeatAt:m.lastHeartbeatAt,sessionUpdatedAt:s.updatedAt,
    canClaim:fresh&&s.actions.claim.allowed,claimUnavailableReason:s.actions.claim.allowed?null:{code:s.actions.claim.reasonCode,message:s.actions.claim.message},
    canQueue:fresh&&Boolean(s.activeTurnId)&&s.actions.queue.allowed,queueUnavailableReason:s.actions.queue.allowed?null:{code:s.actions.queue.reasonCode,message:s.actions.queue.message},
    available:fresh&&s.actions.start.allowed,canAppend:fresh&&s.actions.steer.allowed,
    appendUnavailableReason:s.actions.steer.allowed?null:{code:s.actions.steer.reasonCode,message:s.actions.steer.message},
    unavailableReason:!fresh?{code:'DIRECTORY_STALE',message:'主机或会话状态待同步，请重新核实'}:s.actions.start.allowed?null:{code:s.actions.start.reasonCode,message:s.actions.start.message}};
  });
  // Hosts are a separate inventory, including online hosts without sessions; only host filters apply.
  const hosts=machines.filter(m=>m.reachability==='online'&&m.lastHeartbeatAt&&m.lastHeartbeatAt>=cutoff&&(!machineId||m.machineId===machineId)&&(!host||m.name.toLowerCase().includes(host.toLowerCase())||m.hostname.toLowerCase().includes(host.toLowerCase())));
  return {generatedAt:at.toISOString(),refreshAfterSeconds:15,source:'host_session_projection',status,
   hosts:hosts.slice(0,50).map(m=>({id:m.machineId,name:m.name,heartbeatAt:m.lastHeartbeatAt})),hostTotal:hosts.length,hostsTruncated:hosts.length>50,
   sessions,total,nextCursor:ids.length>20?pageCursor(scope,['id',ids[19]!.id]):null,
   instruction:'Metadata only, not execution authorization or a direct native probe. Query terms are AND across identity fields; structured filters are AND. Hosts use only host filters. For current task use currentTask:true; never fall back silently. If multiple matches, briefly clarify host/project/title/provider. Refresh before selecting; never infer a target from stale entries. Claim, queue, dispatch and steer require explicit current user authorization and server/host admission. Fetch history only on request. Pages reflect a live directory, not a frozen snapshot.'};
 }
 assertFresh(principal:Principal,sessionId:string){
  const s=this.registry.getSession(principal,sessionId),m=this.registry.getMachine(principal,s.machineId);
  invariant(m.identityState==='active'&&m.reachability==='online'&&s.reachability==='live'&&Boolean(m.lastHeartbeatAt&&Date.now()-Date.parse(m.lastHeartbeatAt)<90000),409,'VOICE_TARGET_STALE','目标状态待同步，请刷新并核实；不会自动派发');
 }
}
