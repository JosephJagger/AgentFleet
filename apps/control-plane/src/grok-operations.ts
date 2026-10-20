/** Reviewed Grok ACP surface. Browser callers never supply a method, session id or cwd. */
export const grokOperations = {
  "git.commit": {method:"git/commit",write:true,fields:["message"]},
  "worktrees.diff": {method:"git/diffs",write:false,fields:["worktreePath"]},
  "worktrees.apply": {method:"git/worktree/apply",write:true,fields:["worktreePath"]},
  "subagent.get": {method:"subagent/get",write:false,fields:["subagentId"]},
  "git.status": {method:"git/status",write:false,fields:[]},
  "git.diff": {method:"git/diffs",write:false,fields:[]},
  "search.content": {method:"search/content",write:false,fields:["pattern"]},
  "mcp.authStatus": {method:"mcp/auth_status",write:false,fields:[]},
  "tasks.list": {method:"task/list",write:false,fields:[]},
  "subagents.list": {method:"subagent/list_running",write:false,fields:[]},
  "commands.list": {method:"commands/list",write:false,fields:[]},
  "history.list": {method:"prompt_history",write:false,fields:[]},
  "rewind.list": {method:"rewind/points",write:false,fields:[]},
  "memory.list": {method:"memory/list",write:false,fields:[]},
  "hooks.list": {method:"hooks/list",write:false,fields:[]},
  "plugins.list": {method:"plugins/list",write:false,fields:[]},
  "skills.list": {method:"skills/list",write:false,fields:[]},
  "mcp.list": {method:"mcp/list",write:false,fields:[]},
  "worktrees.list": {method:"git/worktree/list",write:false,fields:[]},
  "worktrees.create": {method:"git/worktree/create",write:true,fields:[]},
  "scheduler.delete": {method:"scheduler/delete",write:true,fields:["taskId"]},
  "task.stop": {method:"task/kill",write:true,fields:["taskId"]},
  "subagent.stop": {method:"subagent/cancel",write:true,fields:["subagentId"]},
  "memory.flush": {method:"memory/flush",write:true,fields:[]},
  "memory.dream": {method:"memory/dream",write:true,fields:[]},
  "memory.preview": {method:"fs/read_file",write:false,fields:["path"]},
  "memory.forget": {method:"memory/forget",write:true,fields:["path","expectedContentHash"]},
  "session.rename": {method:"session/rename",write:true,fields:["title"]},
  "rewind.execute": {method:"rewind/execute",write:true,fields:["targetPromptIndex","mode"]},
  "session.fork": {method:"session/fork",write:true,fields:[]},
  "session.compact": {method:"compact_conversation",write:true,fields:[]},
  "memory.enable": {method:"memory/toggle",write:true,fields:[]},
  "memory.disable": {method:"memory/toggle",write:true,fields:[]},
  "marketplace.list": {method:"marketplace/list",write:true,fields:[]},
  "plugins.install": {method:"plugins/action",write:true,fields:["source"]},
  "plugins.update": {method:"plugins/action",write:true,fields:["pluginId"]},
  "plugins.uninstall": {method:"plugins/action",write:true,fields:["pluginId"]},
  "plugins.enable": {method:"plugins/action",write:true,fields:["pluginId"]},
  "plugins.disable": {method:"plugins/action",write:true,fields:["pluginId"]},
  "plugins.reload": {method:"plugins/action",write:true,fields:[]},
  "hooks.enable": {method:"hooks/action",write:true,fields:["hookName"]},
  "hooks.disable": {method:"hooks/action",write:true,fields:["hookName"]},
  "hooks.reload": {method:"hooks/action",write:true,fields:[]},
  "btw.ask": {method:"btw",write:true,fields:["question"]},
} as const;
export type GrokOperation = keyof typeof grokOperations;
export interface GrokOperationRequest {operation:GrokOperation;arguments:Record<string,string|number>;confirmed?:boolean}
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
export function parseGrokOperation(value:unknown):GrokOperationRequest {
  if(!record(value)||Object.keys(value).some(k=>!['operation','arguments','confirmed'].includes(k))||typeof value.operation!=='string'||!Object.hasOwn(grokOperations,value.operation)||!record(value.arguments))throw Error('Invalid Grok operation');
  const operation=value.operation as GrokOperation, spec=grokOperations[operation], args=value.arguments;
  if(Object.keys(args).some(k=>!(spec.fields as readonly string[]).includes(k))||spec.fields.some(k=>!(k in args)))throw Error('Invalid operation fields');
  for(const [key,v] of Object.entries(args)){
    if(key==='targetPromptIndex'){if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('Invalid checkpoint');}
    else if(typeof v!=='string'||!v.trim()||v.length>(key==='question'||key==='message'?4000:key==='path'||key==='worktreePath'?4096:256)||v.includes('\0'))throw Error('Invalid text');
    if(key==='source'&&!/^https:\/\/[^\s/@:]+(?:\.[^\s/@:]+)+\/[A-Za-z0-9._/-]+$/.test(String(v)))throw Error('Use an explicit HTTPS plugin repository');
    if(key==='mode'&&!['conversation_only','files_only','all'].includes(String(v)))throw Error('Invalid rewind mode');
    if(key==='expectedContentHash'&&(typeof v!=='string'||! /^[a-f0-9]{64}$/.test(v)))throw Error('Invalid hash');
  }
  if(spec.write&&value.confirmed!==true)throw Error('Explicit confirmation required');
  return {operation,arguments:args as Record<string,string|number>,...(spec.write?{confirmed:true}:{})};
}
export function grokLiveOperation(op:GrokOperation){return op==='task.stop'||op==='subagent.stop'||op==='btw.ask';}
export interface GrokOperationResult {operation:string;status:string;rows:{name:string;detail:string;status:string}[]}
/** Select display fields; never forward native environment, credentials or arbitrary envelopes. */
export function grokResult(operation:string,raw:unknown):GrokOperationResult {
  const value=record(raw)&&'result' in raw?raw.result:raw;
  const rows:GrokOperationResult['rows']=[];
  const labels=['completed','exit_code','task_id','display_command','kind','output','turnCount','toolCallCount','contextUsagePct','errorCount','childSessionId','worktreePath','source_repo','session_id','head_commit','commitHash','warning','pushStatus','failureError','cancelReason','line','patch','gitRoot','headCommit','isClean','changeType','additions','deletions','totalMatches','totalFiles','message','disposition','flushed','observation_count','topics_affected','requiresReload','requiresRestart','source','size_bytes','modified_epoch_secs','generated','capture_enabled','dream_enabled','worktreePath','sourceGitRoot','deleted','newSessionId','newCwd','chatMessagesCopied','parentSessionId','prompt_index','prompt_preview','created_at','has_file_changes','success','error','conflict_type','content','truncated','sourceName','sourceKind','pluginRelativePath','version','scope','disabled','pinned','removable','event','handlerType','configSource','toolCount','skillCount','agentCount','hookStatus','mcpStatus','name','title','id','taskId','subagentId','path','serverName','server_name','command','description','text','answer','summary','status','outcome','enabled','contentHash','expectedContentHash','promptIndex','targetPromptIndex','durationMs','tokensUsed','model','branch'];
  function visit(v:unknown,group:string,depth:number){
    if(depth>4||rows.length>=100)return;
    if(Array.isArray(v)){for(const x of v.slice(0,100))visit(x,group,depth+1);return;}
    if(typeof v==='string'&&['prompts','reverted_files','conflicts','clean_files','loadErrors','staged','unstaged','untracked'].includes(group)){rows.push({name:group,detail:v.slice(0,6000),status:''});return;}
    if(!record(v))return;
    const fields=labels.filter(k=>['string','boolean','number'].includes(typeof v[k]));
    if(fields.length)rows.push({name:String(v.name??v.title??v.id??v.taskId??v.task_id??v.subagentId??v.path??group).slice(0,500),status:String(v.status??v.outcome??'').slice(0,80),detail:fields.map(k=>k+': '+String(v[k])).join('\n').slice(0,6000)});
    for(const k of ['tasks','subagents','commands','files','hooks','plugins','skills','servers','tools','sources','worktrees','points','prompts','entries','data','rewind_points','reverted_files','clean_files','conflicts','outcome','loadErrors','snapshot','matches','diffs','staged','unstaged','untracked'])if(k in v)visit(v[k],k,depth+1);
  }
  visit(value,operation,0);
  const v=record(value)?value:{};
  const status=String(v.disposition??v.status??(typeof v.outcome==='string'?v.outcome:undefined)??(v.success===false||record(raw)&&raw.success===false?'failed':'received')).slice(0,80);
  return sanitizeGrokResult({operation,status,rows})!;
}

export function grokNativeDiscovery(raw:unknown){
 if(!record(raw)||raw.nativeManagement!==true)return {};
 const commands=(Array.isArray(raw.commands)?raw.commands:[]).filter(record).filter(c=>typeof c.name==='string'&&/^[a-z0-9-]{1,80}$/.test(c.name)&&typeof c.description==='string').slice(0,80).map(c=>({name:String(c.name),description:String(c.description).slice(0,500),...(typeof c.hint==='string'?{hint:c.hint.slice(0,200)}:{})}));
 return {nativeManagement:true,commands,grokTools:(Array.isArray(raw.grokTools)?raw.grokTools:[]).filter(v=>v==='x_keyword_search'||v==='x_semantic_search')};
}

/** The host and control plane independently enforce the same relay size budget. */
export function sanitizeGrokResult(value:unknown):GrokOperationResult|undefined {
 if(!record(value)||typeof value.operation!=='string'||typeof value.status!=='string'||!Array.isArray(value.rows))return;
 let budget=24000;
 const rows:GrokOperationResult['rows']=[];
 for(const row of value.rows.slice(0,100)){
  if(budget<=0)break;
  if(!record(row)||typeof row.name!=='string'||typeof row.detail!=='string'||typeof row.status!=='string')continue;
  const name=row.name.slice(0,Math.min(500,budget));budget-=name.length;
  const status=row.status.slice(0,Math.min(80,budget));budget-=status.length;
  const detail=row.detail.slice(0,Math.min(6000,budget));budget-=detail.length;
  rows.push({name,status,detail});
 }
 return {operation:value.operation.slice(0,80),status:value.status.slice(0,80),rows};
}
