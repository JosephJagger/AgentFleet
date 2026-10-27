import {acpImageInput,acpImageBlocks,grokImageInterjection} from '../src/acp-images.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcpRuntime} from '../src/acp-runtime.js';
import {AcpConnection} from '../src/acp-connection.js';
import {AgentError} from '../src/errors.js';
import {ACP_PROVIDER_IDS} from '../src/provider-catalog.js';
import type {AppServerCallbacks,AppEvent,VolatileAppEvent} from '../src/app-server.js';
import type {ApprovalRecord,ManagedThread,ProjectRecord} from '../src/types.js';

// A synthetic protocol peer, never a real user CLI or authenticated session.
const peer=String.raw`
const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
if(Number(process.env.ACP_TEST_EXIT_DELAY)>0){
 const keepAlive=setInterval(()=>{},1000);
 process.on('SIGTERM',()=>setTimeout(()=>{clearInterval(keepAlive);process.exit(0);},Number(process.env.ACP_TEST_EXIT_DELAY)));
}
let promptId, sessionId='synthetic-session', requestKind, cursorModel='grok-4', cursorMode='agent';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===991 && !m.method) { send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});send({id:promptId,result:{stopReason:'end_turn'}});return; }
 switch(m.method) {
 case '_test/control':globalThis.control=m.params;send({id:m.id,result:{}});break;
 case '_test/background':globalThis.background=m.params.active;send({id:m.id,result:{}});break;
 case 'initialize':send({id:m.id,result:{_meta:{availableCommands:[{name:'goal',description:'Native goal'}],modelState:{currentModelId:'grok-4',availableModels:[{modelId:'grok-4',name:'Grok test',_meta:{contextWindows:[256000,500000],reasoningEfforts:[{value:'low'},{value:'high'}]}}]}},protocolVersion:1,agentCapabilities:{_meta:{'x.ai/capabilities':{toolOverrides:{x_keyword_search:true,x_semantic_search:true}}},loadSession:true,promptCapabilities:{image:process.env.ACP_TEST_IMAGES==='yes'},sessionCapabilities:{list:{}}}}});break;
 case '_x.ai/interject':
   if(!m.params.sessionId){send({id:m.id,error:{code:-32602,message:'sessionId required'}});return;}
   if(m.params.text==='reject'){send({id:m.id,error:{code:-32601,message:'unsupported'}});return;}
   send({id:m.id,result:{result:{status:'queued'}}});
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:m.params.text}}}});
   if(m.params.text==='finish'){send({id:promptId,result:{stopReason:'end_turn'}});}
   return;
 case '_x.ai/billing':{const at=Date.now();send({id:m.id,result:{config:{creditUsagePercent:25,currentPeriod:{start:new Date(at-86400000).toISOString(),end:new Date(at+6*86400000).toISOString()}}}});break;}
 case '_x.ai/subagent/get':send({id:m.id,result:{result:{snapshot:{subagentId:m.params.subagentId,parentSessionId:m.params.subagentId==='owned-child'?sessionId:'other',status:'completed',output:'result'}}}});break;
 case '_x.ai/git/worktree/list':send({id:m.id,result:{result:[{path:require('node:path').join(process.cwd(),'worktree'),source_repo:process.cwd(),session_id:sessionId,id:'worktree-id'}]}});break;
 case '_x.ai/git/worktree/apply':send({id:m.id,result:{result:{status:'success',files:[]}}});break;
 case '_x.ai/git/commit':send({id:m.id,result:{result:{commitHash:'synthetic'}}});break;
 case '_x.ai/git/diffs':send({id:m.id,result:{result:{files:[]}}});break;
 case '_x.ai/task/list':send({id:m.id,result:{result:{tasks:[{task_id:'owned-task',completed:!globalThis.background}]}}});break;
 case '_x.ai/subagent/list_running':send({id:m.id,result:{result:{subagents:globalThis.background?[{subagentId:'owned-child',parentSessionId:sessionId},{subagentId:'other-child',parentSessionId:'other-session'}]:[]}}});break;
 case '_x.ai/task/kill':case '_x.ai/subagent/cancel':send({id:m.id,result:{result:{outcome:'cancelled'}}});break;
 case '_x.ai/skills/list':send({id:m.id,result:{skills:[{name:'owned-skill'}]}});break;
 case '_x.ai/skills/toggle':case '_x.ai/mcp/toggle':case '_x.ai/mcp/toggle_tool':case '_x.ai/git/stage':case '_x.ai/git/unstage':send({id:m.id,result:{result:{ok:true}}});break;
 case '_x.ai/mcp/list':send({id:m.id,result:{result:{servers:[{name:'owned-server',session:{tools:[{name:'owned-tool'}]}}]}}});break;
 case '_x.ai/workflows/list':send({id:m.id,result:{workflows:[{name:'review'}]}});break;
 case '_x.ai/fs/list':send({id:m.id,result:{result:{entries:[{name:'example.txt'}]}}});break;
 case '_x.ai/memory/list':send({id:m.id,result:{files:[{path:'/native-memory.md',generated:false}]}});break;
 case '_x.ai/fs/read_file':send({id:m.id,result:{result:{content:'note',size:4,type:'text'}}});break;
 case '_x.ai/memory/forget':send({id:m.id,result:{outcome:'forgotten'}});break;
 case '_x.ai/memory/flush':send({id:m.id,result:{disposition:'flushed'}});break;
 case '_x.ai/prompt_history':send({id:m.id,result:{prompts:['first','second']}});break;
 case '_x.ai/session/fork':send({id:m.id,result:{newSessionId:'forked',newCwd:m.params.newCwd,parentSessionId:m.params.sourceSessionId}});break;
 case '_x.ai/rewind/points':send({id:m.id,result:{rewind_points:[{prompt_index:1,has_file_changes:false,prompt_preview:'test'}]}});break;
 case '_x.ai/rewind/execute':send({id:m.id,result:{success:true}});break;
 case 'session/list':send({id:m.id,result:{sessions:[{sessionId,cwd:process.env.ACP_TEST_CWD??process.cwd(),title:'Synthetic'}]}});break;
 case 'session/new':send({id:m.id,result:{sessionId,configOptions:[{id:'model',options:['grok-4.6','grok-4'],currentValue:'grok-4'},{id:'reasoning_effort',options:['low','high'],currentValue:'low'},...(process.env.ACP_TEST_PROVIDER==='cursor'?[{id:'mode',options:['agent','plan','ask'],currentValue:'agent'}]:[])]}});break;
 case 'session/load':if(process.env.ACP_TEST_IMAGES==='yes')send({method:'session/update',params:{sessionId,update:{sessionUpdate:'user_message_chunk',content:{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}}}});send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Retained history'}}}});send({id:m.id,result:{configOptions:[{id:'model',options:['grok-4.6','grok-4'],currentValue:'grok-4'},{id:'reasoning_effort',options:['low','high'],currentValue:'low'},...(process.env.ACP_TEST_PROVIDER==='cursor'?[{id:'mode',options:['agent','plan','ask'],currentValue:'agent'}]:[])]}});break;
 case 'cursor/list_available_models':send({id:m.id,result:{models:[{value:'grok-4',name:'Cursor test model',configOptions:[]}]}});break;
 case 'session/set_mode':if(globalThis.control?.deferredMode){send({id:m.id,result:{}});setTimeout(()=>send({method:'session/update',params:{sessionId,update:{sessionUpdate:'current_mode_update',currentModeId:m.params.modeId}}}),20);break;}if(globalThis.control?.invalidMode){send({id:m.id,result:null});break;}if(globalThis.control?.rejectMode){send({id:m.id,error:{code:-32601}});break;}if(!m.params.sessionId){send({id:m.id,error:{code:-32602}});break;}send({method:'session/update',params:{sessionId,update:{sessionUpdate:'current_mode_update',currentModeId:m.params.modeId}}});send({id:m.id,result:{}});break;
 case '_x.ai/yolo_mode_changed':break;
 case '_x.ai/session/info':send({id:m.id,result:{result:{sessionId,model:'grok-4'}}});break;
 case 'session/set_model':send({id:m.id,result:{}});break;
 case 'session/set_config_option':
   if(globalThis.control?.ignoreConfig){send({id:m.id,result:{configOptions:[]}});break;}
   if(typeof m.params.value!=='string'||!['model','reasoning_effort','mode'].includes(m.params.configId)){process.exit(9);return;}
   if(process.env.ACP_TEST_PROVIDER==='cursor'){if(m.params.configId==='model')cursorModel=m.params.value;if(m.params.configId==='mode')cursorMode=m.params.value;send({id:m.id,result:{configOptions:[{id:'model',currentValue:cursorModel,options:['grok-4','grok-4.6']},{id:'mode',currentValue:cursorMode,options:['agent','plan','ask']}]}});break;}
   send({id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value,options:[m.params.value]}]}});break;
 case 'session/prompt':
   promptId=m.id;requestKind=m.params.prompt[0].text;
   if(requestKind==='cursor-settings'){send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'configured'}}}});send({id:m.id,result:{stopReason:'end_turn'}});return;}
   if(requestKind==='images'||requestKind===''){send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.params.prompt)}}}});send({id:m.id,result:{stopReason:'end_turn'}});return;}
   if(requestKind==='disconnect'){process.exit(7);return;}
   if(requestKind==='wait')return;
   if(requestKind==='permission'){send({id:991,method:'session/request_permission',params:{sessionId,toolCall:{title:'Synthetic write'},options:[{optionId:'one',kind:'allow_once'},{optionId:'all',kind:'allow_always'},{optionId:'no',kind:'reject_once'}]}});return;}
   if(requestKind.startsWith('grok-plan')){send({id:991,method:'_x.ai/exit_plan_mode',params:{sessionId,toolCallId:'plan-1',planContent:requestKind==='grok-plan-large'?'x'.repeat(64001):requestKind==='grok-plan-empty'?null:'# Proposed plan\n\nCreate hello.txt only after approval.'}});return;}
   if(requestKind==='grok-question'){send({id:991,method:'_x.ai/ask_user_question',params:{sessionId,toolCallId:'question-1',mode:'plan',questions:[{question:'Which database?',options:[{label:'SQLite',description:'Local'}]}]}});return;}
   if(requestKind==='grok-question-null'){send({id:991,method:'_x.ai/ask_user_question',params:{sessionId,toolCallId:'question-null',questions:[{question:'Which database?',multi_select:null,multiSelect:null,options:[{label:'SQLite',description:'Local'}]}]}});return;}
   if(requestKind==='grok-question-multi'){send({id:991,method:'_x.ai/ask_user_question',params:{sessionId,toolCallId:'question-2',questions:[{question:'Which databases?',multi_select:true,options:[{label:'SQLite',description:'Local'},{label:'Postgres',description:'Server'}]}]}});return;}
   if(requestKind==='grok-question-preview'){send({id:991,method:'_x.ai/ask_user_question',params:{sessionId,toolCallId:'question-3',questions:[{question:'Preview?',options:[{label:'A',preview:'hidden'}]}]}});return;}
   if(requestKind==='grok-form'){send({id:991,method:'_x.ai/mcp/elicit',params:{sessionId,serverName:'test-mcp',toolCallId:'form-1',mode:'form',message:'Confirm choice',requestedSchema:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled']}}});return;}
   if(requestKind==='question'){send({id:991,method:'cursor/ask_question',params:{toolCallId:'q',questions:[{id:'q1',prompt:'Choose',options:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]}]}});return;}
   if(requestKind==='burst'){
     for(let i=0;i<200;i++) send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'t'+i,title:'T'+i,kind:'execute',status:'in_progress',rawInput:{command:'echo '+i}}}});
     send({id:m.id,result:{stopReason:'end_turn'}});return;
   }
   if(requestKind==='grok-native'){
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'read',title:'read_file',rawInput:{target_file:'sample.txt'}}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'read',status:'completed',rawOutput:{type:'ReadFile',FileContent:{content:'synthetic'}},content:[{type:'content',content:{type:'text',text:'synthetic file contents'}}]}}});
     send({method:'_x.ai/session_notification',params:{sessionId,update:{sessionUpdate:'retry_state',type:'retrying',attempt:1,max_retries:3,reason:'secret native error must not be forwarded'}}});
     send({method:'_x.ai/session_notification',params:{sessionId,update:{sessionUpdate:'turn_completed',stop_reason:'end_turn'}}});
     return;
   }
   if(requestKind==='progress'){
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'before tool'}}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'edit',title:'Edit',status:'completed',content:[{type:'diff',path:'sample.ts',oldText:'const a=1;',newText:'const a=2;'}]}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'working'}}}});
     return;
   }
   if(requestKind==='tools'){
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'bash',title:'Bash',kind:'execute',status:'in_progress',rawInput:{command:'npm test'}}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'bash',status:'in_progress',rawOutput:'partial'}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'bash',status:'in_progress',rawOutput:'replaced'}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'bash',status:'completed',rawOutput:'replaced'}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'plan',entries:[{status:'pending',content:'check tests'}]}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}}}});
     send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}}}});
     send({id:m.id,result:{stopReason:'end_turn',usage:{input_tokens:3,output_tokens:2,total_tokens:5}}});return;
   }
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello '}}}});
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'世界'}}}});
   send({id:m.id,result:{stopReason:'end_turn'}});break;
 case 'session/cancel':send({id:promptId,result:{stopReason:'cancelled'}});break;
 }
});`;
async function fixture(t: TestContext,provider: typeof ACP_PROVIDER_IDS[number]='qwen',images=false,exitDelay=0,grokVersion='grok 1.0.70 (synthetic)') {
 const dir=await mkdtemp(join(tmpdir(),'acp-test-'));const file=join(dir,'peer.cjs');await writeFile(file,peer);
 const events:AppEvent[]=[];const batches:AppEvent[][]=[];const volatiles:VolatileAppEvent[]=[];const approvals:ApprovalRecord[]=[];const exits:string[]=[];const launches:string[][]=[];const batchWatchers:Array<()=>void>=[];
 const project:ProjectRecord={id:'project-test',alias:'synthetic',provider,root:dir,device:'test',inode:'test',identityVersion:1,addedAt:new Date().toISOString()};
 let thread:ManagedThread|undefined;
 const callbacks:AppServerCallbacks={findManagedThread:id=>thread?.nativeThreadId===id?thread:undefined,findProject:()=>project,onEvent:async e=>{events.push(e);},onEvents:async batch=>{batches.push(batch);events.push(...batch);for(const watch of batchWatchers)watch();},onVolatile:e=>{volatiles.push(e);},onApproval:async a=>{approvals.push(a);},onApprovalResolved:async()=>{},onExit:async()=>{},onThreadExit:async id=>{exits.push(id);}};
 const counts={connections:0};const requests:Array<{method:string;params:Record<string,unknown>}>=[];
 let terminalRows:import('../src/cursor-sessions.js').CursorTerminalSession[]=[];const prepared:string[]=[];const environments:Array<NodeJS.ProcessEnv|undefined>=[];
 let ownershipFailure:AgentError|undefined;
 const children:AcpConnection[]=[];
 const runtime=new AcpRuntime(provider,callbacks,'epoch-test',{cursorSessions:async()=>terminalRows,prepareCursor:async row=>{prepared.push(row.id);},readGrokUsage:async()=>undefined,readCursorQuota:async()=>undefined,detect:async()=>({executable:process.execPath,prefix:[file],version:provider==='grok'?grokVersion:'synthetic-1.0.0'}),unoccupied:async(_provider,owned)=>{
   if(ownershipFailure)throw ownershipFailure;
   // Model the actual OS process scan, including children still exiting.
   for(const connection of children)if(connection.pid&&!owned.has(connection.pid)){
     let alive=false;try{process.kill(connection.pid,0);alive=true;}catch{}
     if(alive)throw new AgentError('PROVIDER_NATIVE_BUSY','Owned child was forgotten before process exit');
   }
 },connection:options=>{environments.push(options.env);counts.connections++;launches.push(options.args);const child=new AcpConnection({...options,env:{...process.env,ACP_TEST_PROVIDER:provider,ACP_TEST_CWD:project.root,ACP_TEST_IMAGES:images?'yes':'no',ACP_TEST_EXIT_DELAY:String(exitDelay)}});const originalNotify=child.notify.bind(child);child.notify=(method,params)=>{requests.push({method,params});originalNotify(method,params);};const original=child.call.bind(child);child.call=(method,params,timeout)=>{requests.push({method,params});return original(method,params,timeout);};children.push(child);return child;}});
 t.after(async()=>{await runtime.stop();await rm(dir,{recursive:true,force:true});});
 await runtime.start();const created=await runtime.createThread(project);
 thread={nativeThreadId:created.nativeThreadId,projectId:project.id,appServerEpoch:'epoch-test',policyVersion:'remote-restricted-v1',policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString(),historyMode:'legacy'} as ManagedThread;
 return {runtime,thread,project,requests,prepared,environments,setTerminalRows:(rows:typeof terminalRows)=>{terminalRows=rows;},events,batches,batchWatchers,volatiles,approvals,exits,counts,launches,children,setOwnershipFailure:(error:AgentError|undefined)=>{ownershipFailure=error;}};
}
test('closing catalog children stay owned and cannot cause a false external-writer refusal',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,'grok',false,250);
 await f.runtime.listThreads();
 assert.equal(f.children[1]?.closing,true);
 await f.runtime.startTurn(f.thread,f.project,'hello');
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
});
test('writer release and concurrent resume wait for confirmed process exit',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,'grok',false,250);const old=f.children[0]!;
 let released=false;
 const release=f.runtime.unsubscribeThread(f.thread.nativeThreadId).then(()=>{released=true;});
 const resume=f.runtime.resumeThread(f.thread.nativeThreadId,f.project);
 await new Promise(r=>setTimeout(r,40));
 assert.equal(released,false);assert.equal(f.counts.connections,1);assert.equal(old.closing,true);
 await Promise.all([release,resume]);
 assert.equal(old.closing,false);assert.equal(f.counts.connections,2);
 assert.equal(f.events.some(e=>e.type==='turn.completed'),false,'Resume never replays a task');
});
test('release timeout retains the closing process until exit and can be safely awaited again',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,'grok',false,250);const connection=f.children[0]!;
 await assert.rejects(connection.closeAndWait(5),{code:'PROVIDER_RELEASE_PENDING'});
 assert.equal(connection.closing,true);
 await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);
 assert.equal(connection.closing,false);assert.equal(f.counts.connections,2);
 assert.equal(f.events.length,0,'No prompt is replayed after waiting for exit');
});
for(const provider of ACP_PROVIDER_IDS)for(const code of ['PROVIDER_NATIVE_BUSY','PROVIDER_OWNERSHIP_UNKNOWN'])test(`${provider}: ${code} rejects even an open session before dispatch`,async t=>{
 const f=await fixture(t,provider);const before=f.counts.connections;
 f.setOwnershipFailure(new AgentError(code,'Ownership preflight refused'));
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello'),{code});
 assert.equal(f.counts.connections,before);assert.equal(f.events.length,0);
 f.setOwnershipFailure(undefined);
 await f.runtime.startTurn(f.thread,f.project,'hello');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
});
async function until(predicate:()=>boolean){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error('Synthetic protocol timed out');await new Promise(r=>setTimeout(r,5));}}
for(const provider of ACP_PROVIDER_IDS)test(`${provider}: native ID, streamed text, completion and history round trip`,async t=>{
 const f=await fixture(t,provider);const catalog=await f.runtime.listThreads();assert.equal(catalog[0]?.nativeThreadId,f.thread.nativeThreadId);
 const turn=await f.runtime.startTurn(f.thread,f.project,'hello');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text==='Hello 世界'));
 assert.equal(f.events.at(-1)?.nativeTurnId,turn.nativeTurnId);
 await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 const resumed=await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);assert.equal(resumed.history.items[0]?.item?.text,'Retained history');
 assert.equal(resumed.history.itemIdStability,'snapshot','ACP replay must not advertise stable native item IDs');
});
test('native permission accepts once, rejects stale replies and never selects allow-always',async t=>{
 const f=await fixture(t);await f.runtime.startTurn(f.thread,f.project,'permission');await until(()=>f.approvals.length===1);
 await assert.rejects(f.runtime.respondApproval({...f.approvals[0]!,appServerEpoch:'old'},'accept'),/no longer current/);
 await f.runtime.respondApproval(f.approvals[0]!,'accept');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>String((e.payload.item as {text?:string})?.text).includes('"optionId":"one"')));
 await assert.rejects(f.runtime.respondApproval(f.approvals[0]!,'accept'),/no longer current/);
});
test('Cursor questions without sessionId remain bound to their owned connection',async t=>{
 const f=await fixture(t,'cursor');await f.runtime.startTurn(f.thread,f.project,'question');await until(()=>f.approvals.length===1);
 await f.runtime.respondInput(f.approvals[0]!,{q1:{answers:['Beta']}});await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>String((e.payload.item as {text?:string})?.text).includes('"selectedOptionIds":["b"]')));
});
test('cancel waits for native completion and a dropped connection never reports success or replays',async t=>{
 const f=await fixture(t);let turn=await f.runtime.startTurn(f.thread,f.project,'wait');assert.equal(f.events.some(e=>e.type==='turn.completed'),false);
 await new Promise(r=>setTimeout(r,20));await f.runtime.interruptTurn(f.thread.nativeThreadId,turn.nativeTurnId);await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal((f.events.at(-1)?.payload.turn as {status:string}).status,'interrupted');
 turn=await f.runtime.startTurn(f.thread,f.project,'disconnect');await until(()=>f.exits.length===1);
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);assert.equal(await f.runtime.readTurnOutcome(f.thread.nativeThreadId,turn.nativeTurnId),null);
});
test('tool calls, plans and reported usage stream before the turn result',async t=>{
 const f=await fixture(t);await f.runtime.startTurn(f.thread,f.project,'tools');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const completed=f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {command?:string})?.command==='npm test');
 assert.equal(completed.length,1);assert.equal((completed[0]!.payload.item as {aggregatedOutput?:string}).aggregatedOutput,'replaced');
 assert.equal(f.events.filter(e=>e.type==='item.started'&&(e.payload.item as {command?:string})?.command==='npm test').length,1);
 const deltas=f.volatiles.filter(e=>e.type==='command_output.delta');
 assert.deepEqual(deltas.map(e=>e.payload.delta),['partial','replaced']);assert.equal(deltas[1]?.payload.replace,true);
 assert.equal(f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {type?:string}).type==='plan').length,1);
 assert.ok(f.events.some(e=>(e.payload.item as {text?:string})?.text==='done'));
 assert.ok(f.events.some(e=>(e.payload.item as {text?:string})?.text==='thinking'));
 const usage=f.events.find(e=>e.type==='thread.usage');
 assert.equal((usage?.payload.usage as {total:{inputTokens:number;totalTokens:number}}).total.inputTokens,3);
 assert.equal((usage?.payload.usage as {total:{totalTokens:number}}).total.totalTokens,5);
});
test('a large completion flush yields to timers and keeps the terminal event last',async t=>{
 const f=await fixture(t);
 let during=false;
 // setInterval(0) is clamped to about 1ms, so a synchronous callback finishes the flush first.
 // This immediate is queued as the first chunk is saved and runs before flush continues.
 f.batchWatchers.push(()=>setImmediate(()=>{if(f.batches.length>0&&!f.events.some(e=>e.type==='turn.completed'))during=true;}));
 await f.runtime.startTurn(f.thread,f.project,'burst');
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(during,true);
 assert.equal(f.batches.length,Math.ceil(200/32));
 assert.ok(f.batches.every(batch=>batch.length<=32));
 const completed=f.events.filter(e=>e.type==='item.completed'&&String(e.nativeItemId).includes(':tool:'));
 assert.equal(completed.length,200);
 assert.deepEqual(completed.map(e=>e.nativeItemId),completed.map((_,i)=>`${f.events.find(e=>e.type==='turn.completed')!.nativeTurnId}:tool:t${i}`));
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
 assert.equal(f.events.at(-1)?.type,'turn.completed');
 assert.equal(f.launches.length,1);
});
test('grok confirms model and switches real task mode without inventing a config option',async t=>{
 const f=await fixture(t,'grok');
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{model:'grok-4.6',effort:'high',permissionMode:'always',mode:'plan'});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const args=f.launches.at(-1)!;
 assert.ok(args.includes('--model')&&args.includes('grok-4.6')&&args.includes('--always-approve'));
 assert.ok(args.indexOf('--model')<args.lastIndexOf('stdio'));
 const options=(f.events.find(e=>e.type==='turn.completed')?.payload.configOptions??[]) as Array<{id:string;current?:string}>;
 assert.equal(options.find(o=>o.id==='model')?.current,'grok-4.6');
 assert.equal(options.find(o=>o.id==='reasoning_effort')?.current,'high');
 assert.equal(options.some(o=>o.id==='mode'),false);
 assert.ok(f.requests.some(r=>r.method==='session/set_mode'&&r.params.modeId==='plan'));
 assert.equal((f.events.find(e=>e.type==='turn.completed')?.payload.grokState as {mode:string}).mode,'plan');
 assert.ok(args.includes('--no-leader'));
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{model:'grok-4.6',sandbox:'danger'} as never),/plain text/);
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{model:'grok-4.6'},['data:image/png;base64,aaaa']),/图片格式或大小无效/);
});
test('unsupported inputs fail before native work',async t=>{
 const f=await fixture(t);await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{model:'other'}),/plain text/);assert.equal(f.events.length,0);
});
test('transport fences malformed stdout and never retries timed out requests',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'acp-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let exits=0;const c=new AcpConnection({executable:process.execPath,args:['-e',"process.stdin.on('data',()=>process.stdout.write('not-json\\n'))"],cwd:dir,notification:()=>{},request:async()=>null,exit:()=>{exits++;}});c.start();t.after(()=>c.close());
 await assert.rejects(c.call('initialize',{},5000),/invalid JSON/);assert.equal(exits,1);
});

test('native ownership uncertainty refuses a writer before spawning it',async()=>{
 let spawned=0;
 const runtime=new AcpRuntime('qwen',{findManagedThread:()=>undefined,findProject:()=>undefined,onEvent:async()=>{},onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{}},'epoch-test',{
  detect:async()=>({executable:process.execPath,prefix:[],version:'fixture-1.0.0'}),
  unoccupied:async()=>{throw new Error('Ownership unknown');},connection:()=>{spawned++;throw new Error('Must not spawn');},
 });
 await runtime.start();await assert.rejects(runtime.createThread({id:'synthetic',root:tmpdir()} as ProjectRecord),/Ownership unknown/);assert.equal(spawned,0);await runtime.stop();
});
test('transport timeout does not replay the request or accept its late result',async t=>{
 const source="let count=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='slow'){count++;setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'late'})+'\\n'),100);}else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:count})+'\\n');});";
 const c=new AcpConnection({executable:process.execPath,args:['-e',source],cwd:tmpdir(),notification:()=>{},request:async()=>null,exit:()=>{}});c.start();t.after(()=>c.close());
 await assert.rejects(c.call('slow',{},10),/do not replay/);await new Promise(r=>setTimeout(r,200));assert.equal(await c.call('count',{},5000),1);
});

test('concurrent history restore and claim share one native session writer',async t=>{
 const f=await fixture(t);await f.runtime.unsubscribeThread(f.thread.nativeThreadId);const before=f.counts.connections;
 await Promise.all([f.runtime.resumeThread(f.thread.nativeThreadId,f.project),f.runtime.readThread(f.thread.nativeThreadId)]);
 assert.equal(f.counts.connections-before,1);
});

const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
for(const provider of ACP_PROVIDER_IDS)test(`${provider}: images use ACP blocks and survive history, including image-only prompts`,async t=>{
 const f=await fixture(t,provider,true);assert.equal(f.runtime.availability.capabilities.images,true);
 for(const prompt of ['images','']) {
  const before=f.events.filter(e=>e.type==='turn.completed').length;
  await f.runtime.startTurn(f.thread,f.project,prompt,undefined,provider==='grok'?{permissionMode:'default'}:undefined,[png,png]);
  await until(()=>f.events.filter(e=>e.type==='turn.completed').length===before+1);
  const reply=f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='agentMessage').at(-1)!;
  const blocks=JSON.parse(String((reply.payload.item as {text:string}).text));
  assert.deepEqual(blocks,[{type:'text',text:prompt},...acpImageBlocks([png,png])]);
  const history=await f.runtime.readThread(f.thread.nativeThreadId);
  assert.deepEqual(history.items.filter(e=>e.item?.type==='userMessage').at(-1)!.item!.content,[{type:'text',text:prompt},{type:'image',url:png},{type:'image',url:png}]);
 }
});
test('unsupported or malformed images are rejected without starting a turn; another handshake cannot override session capability',async t=>{
 const f=await fixture(t);assert.equal(f.runtime.availability.capabilities.images,false);
 f.runtime.availability.capabilities.images=true;
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'images',undefined,undefined,[png]),{code:'AGENT_IMAGE_UNSUPPORTED'});
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'images',undefined,undefined,['file:///private/test.png']));
 assert.equal(f.events.length,0);
 assert.equal((await f.runtime.readThread(f.thread.nativeThreadId)).executionState,'idle');
});
test('Grok image workaround is restricted to the verified native version and identity',()=>{
 const init={agentCapabilities:{promptCapabilities:{image:false}},_meta:{grokShell:true}};
 assert.equal(acpImageInput('grok','grok 1.0.62 (fixture) [stable]',init),true);
 for(const version of ['grok 1.0.63','grok 1.0.620','synthetic-1.0.62','grok 0.2.87'])assert.equal(acpImageInput('grok',version,init),false);
 assert.equal(acpImageInput('qwen','grok 1.0.62',init),false);
 assert.equal(acpImageInput('grok','grok 1.0.62',{agentCapabilities:{}}),false);
 for(const provider of ACP_PROVIDER_IDS)assert.equal(acpImageInput(provider,'new-version',{agentCapabilities:{promptCapabilities:{image:true}}}),true);
});

test('native image history remains visible after releasing and restoring a session',async t=>{
 const f=await fixture(t,'grok',true);
 await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 const restored=await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);
 const user=restored.history.items.find(i=>i.item?.type==='userMessage');
 assert.deepEqual(user?.item?.content,[{type:'text',text:''},{type:'image',url:png}]);
});

test('Grok catalog is available before a prompt, unsupported config is rejected before sending',async t=>{
 const f=await fixture(t,'grok');
 assert.deepEqual(f.runtime.availability.models,[{id:'grok-4',name:'Grok test',efforts:['low','high'],contextWindows:[256000,500000]}]);
 assert.equal(f.runtime.availability.capabilities.models,true);
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'do not send',undefined,{model:'missing'}),{code:'GROK_OPTION_UNAVAILABLE'});
 assert.equal(f.events.length,0);
});
test('intermediate replies, reasoning and code changes appear before a long-running prompt completes',async t=>{
 const f=await fixture(t,'grok');
 const turn=await f.runtime.startTurn(f.thread,f.project,'progress');
 await until(()=>f.events.some(e=>e.type==='item.started'&&(e.payload.item as {text?:string})?.text==='working'));
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text==='before tool'));
 const change=f.events.find(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='fileChange');
 assert.ok(JSON.stringify(change?.payload).includes('+const a=2;'));
 assert.equal(f.events.some(e=>e.type==='turn.completed'),false);
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'not sent',undefined,{model:'missing'}),{code:'PROVIDER_TURN_ACTIVE'});
 await f.runtime.interruptTurn(f.thread.nativeThreadId,turn.nativeTurnId);
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text==='before tool').length,1);
});

test('Grok native nested output and extension progress remain visible without falsely completing',async t=>{
 const f=await fixture(t,'grok');
 await f.runtime.listThreads();
 assert.equal(f.runtime.availability.quota?.windows[0]?.remainingPercent,75);
 const turn=await f.runtime.startTurn(f.thread,f.project,'grok-native');
 await until(()=>f.events.some(e=>(e.payload.item as {text?:string})?.text?.includes('正在重试')));
 const tool=f.events.find(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='commandExecution');
 assert.equal((tool?.payload.item as {aggregatedOutput?:string}).aggregatedOutput,'synthetic file contents');
 assert.equal(f.events.some(e=>e.type==='turn.completed'),false);
 assert.ok(!JSON.stringify(f.events).includes('secret native error'));
 assert.equal((await f.runtime.readTurnOutcome(f.thread.nativeThreadId,turn.nativeTurnId))?.status,'inProgress');
 await f.runtime.interruptTurn(f.thread.nativeThreadId,turn.nativeTurnId);
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='commandExecution').length,1);
});


test('Grok native interject targets the existing turn, rejects stale input and preserves its writer',async t=>{
 const f=await fixture(t,'grok');
 assert.equal(f.runtime.availability.capabilities.steer,true);
 const turn=await f.runtime.startTurn(f.thread,f.project,'wait');
 // Give the asynchronous original session/prompt a chance to reach the native fixture.
 await new Promise(r=>setTimeout(r,30));
 const count=f.counts.connections;
 await assert.rejects(f.runtime.steerTurn(f.thread,'stale','finish'),/changed/);
 await assert.rejects(f.runtime.steerTurn(f.thread,turn.nativeTurnId,'reject'),{code:'AGENT_CAPABILITY_UNAVAILABLE'});
 const receipt=await f.runtime.steerTurn(f.thread,turn.nativeTurnId,'finish','unique-input');
 assert.equal(receipt.status,'queued');assert.equal(receipt.nativeTurnId,turn.nativeTurnId);
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const users=f.events.filter(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='userMessage');
 assert.deepEqual(users.map(e=>(e.payload.item as {content:Array<{text:string}>}).content[0]?.text),['wait','finish']);

 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
 assert.equal(f.counts.connections,count);
 await assert.rejects(f.runtime.steerTurn(f.thread,turn.nativeTurnId,'late'),/changed/);
});
test('other ACP providers cannot borrow Grok native steering',async t=>{
 const f=await fixture(t,'qwen');assert.equal(f.runtime.availability.capabilities.steer,false);
 await assert.rejects(f.runtime.steerTurn(f.thread,'turn','hello'),/unavailable/);
});

test('Cursor terminal discovery, takeover and continuation keep provider, native ID and config root',async t=>{
 const f=await fixture(t,'cursor');await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 f.setTerminalRows([{id:'synthetic-session',cwd:f.project.root,title:'Terminal Cursor session',root:f.project.root,directory:f.project.root,database:join(f.project.root,'native.db'),updatedAt:1}]);
 const rows=await f.runtime.listThreads();assert.equal(rows.find(r=>r.nativeThreadId===f.thread.nativeThreadId)?.title,'Terminal Cursor session');
 assert.equal(f.prepared.length,0,'Discovery is read-only');
 f.setOwnershipFailure(new AgentError('PROVIDER_NATIVE_BUSY','Native terminal still open'));
 await assert.rejects(f.runtime.resumeThread(f.thread.nativeThreadId,f.project),{code:'PROVIDER_NATIVE_BUSY'});assert.equal(f.prepared.length,0);
 f.setOwnershipFailure(undefined);
 const resumed=await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);
 assert.equal(resumed.nativeThreadId,f.thread.nativeThreadId);assert.ok(JSON.stringify(resumed.history.items).includes('Retained history'));
 assert.equal(f.environments.at(-1)?.CURSOR_CONFIG_DIR,f.project.root);assert.deepEqual(f.prepared,['synthetic-session']);
 await f.runtime.startTurn(f.thread,f.project,'hello');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.every(e=>e.nativeThreadId===f.thread.nativeThreadId));
});


test('Cursor native config survives resume, applies before prompt, and never borrows Grok settings',async t=>{
 const f=await fixture(t,'cursor');
 await f.runtime.listThreads();
 assert.equal(f.runtime.availability.cursorModels?.[0]?.name,'Cursor test model');
 const resumed=await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);
 assert.ok((resumed.rawSummary?.cursorOptions as unknown[])?.length);
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'cursor-settings',undefined,{options:{model:'unknown'}}),{code:'CURSOR_OPTION_UNAVAILABLE'});
 assert.equal(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {type?:string})?.type==='userMessage'),false);
 await f.runtime.startTurn(f.thread,f.project,'cursor-settings',undefined,{options:{model:'grok-4',mode:'plan'}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const options=f.events.find(e=>e.type==='turn.completed')?.payload.cursorOptions as Array<{id:string;current:string}>;
 assert.equal(options.find(o=>o.id==='mode')?.current,'plan');
 assert.equal(f.events.some(e=>e.type==='thread.usage'),false);
});

test('Cursor per-session allow uses one-time native permissions; resets on next turn',async t=>{
 const f=await fixture(t,'cursor');
 await f.runtime.startTurn(f.thread,f.project,'permission',undefined,{permissionMode:'always'});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.approvals.length,0);
 assert.ok(f.events.some(e=>String((e.payload.item as {text?:string})?.text).includes('"optionId":"one"')));
 assert.ok(!f.events.some(e=>String((e.payload.item as {text?:string})?.text).includes('"optionId":"all"')));
 await f.runtime.startTurn(f.thread,f.project,'permission');
 await until(()=>f.approvals.length===1);
 await f.runtime.respondApproval(f.approvals[0]!,'decline');
 await until(()=>f.events.filter(e=>e.type==='turn.completed').length===2);
});


test('Cursor flat per-turn usage accumulates actual counts instead of losing equal consecutive turns',async t=>{
 const f=await fixture(t,'cursor');
 for(let i=1;i<=2;i++){
  await f.runtime.startTurn(f.thread,f.project,'tools');
  await until(()=>f.events.filter(e=>e.type==='turn.completed').length===i);
 }
 const usage=f.events.filter(e=>e.type==='thread.usage').map(e=>e.payload.usage as {total:{totalTokens:number};last:{totalTokens:number}});
 assert.deepEqual(usage.map(u=>u.total.totalTokens),[5,10]);
 assert.deepEqual(usage.map(u=>u.last.totalTokens),[5,5]);
});

test('Cursor quota cache survives only same-credential account-query outages and clears on native auth failure',async()=>{
 let identity='a',outage=false,authFailure=false;
 const quota={observedAt:new Date().toISOString(),windows:[]};
 const runtime=new AcpRuntime('cursor',{} as AppServerCallbacks,'quota-audit',{
  detect:async()=>({executable:process.execPath,prefix:[],version:'mock'}),
  readCursorQuota:async options=>{options?.onIdentity?.(identity);if(outage)throw Error('offline');return quota;},
  connection:()=>({start(){},close(){},call:async(method:string)=>{if(authFailure)throw new AgentError('ACP_REMOTE_ERROR','Native request rejected (-32000)');return method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:{models:[]};}} as unknown as AcpConnection)
 });
 await runtime.listThreads();assert.equal(runtime.availability.cursorQuota,quota);
 outage=true;Reflect.set(runtime,'quotaCheckedAt',0);await runtime.listThreads();assert.equal(runtime.availability.cursorQuota,quota);
 identity='b';Reflect.set(runtime,'quotaCheckedAt',0);await runtime.listThreads();assert.equal(runtime.availability.cursorQuota,undefined);
 outage=false;Reflect.set(runtime,'quotaCheckedAt',0);await runtime.listThreads();assert.equal(runtime.availability.cursorQuota,quota);
 authFailure=true;await assert.rejects(runtime.listThreads());assert.equal(runtime.availability.state,'login_required');assert.equal(runtime.availability.cursorQuota,undefined);
});

test('Grok management binds native identity and cwd; input history and memory use native spelling',async t=>{
 const f=await fixture(t,'grok');
 await f.runtime.manageGrok(f.thread,f.project,{operation:'history.list',arguments:{}});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/prompt_history')?.params,{cwd:f.project.root,filter_session_id:'synthetic-session'});
 await f.runtime.manageGrok(f.thread,f.project,{operation:'memory.flush',arguments:{},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/memory/flush')?.params,{session_id:'synthetic-session'});
 await f.runtime.manageGrok(f.thread,f.project,{operation:'session.fork',arguments:{},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/session/fork')?.params,{sourceSessionId:'synthetic-session',sourceCwd:f.project.root,newCwd:f.project.root});
});
test('Grok stop cannot target an unlisted task or another parent subagent',async t=>{
 const f=await fixture(t,'grok');
 await f.children[0]!.call('_test/background',{active:true});
 for(const [operation,args] of [['task.stop',{taskId:'unknown'}],['subagent.stop',{subagentId:'other-child'}]] as const)await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation,arguments:args,confirmed:true}),{code:'GROK_TARGET_CHANGED'});
 assert.equal(f.requests.some(r=>r.method==='_x.ai/task/kill'||r.method==='_x.ai/subagent/cancel'),false);
 await f.runtime.manageGrok(f.thread,f.project,{operation:'subagent.stop',arguments:{subagentId:'owned-child'},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/subagent/cancel')?.params,{subagentId:'owned-child'});
});
test('Grok memory deletion requires a complete current preview and is single use',async t=>{
 const f=await fixture(t,'grok');
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'memory.forget',arguments:{path:'/native-memory.md',expectedContentHash:'0'.repeat(64)},confirmed:true}),{code:'GROK_MEMORY_PREVIEW_REQUIRED'});
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'memory.preview',arguments:{path:'/other-secret'}}),{code:'GROK_TARGET_CHANGED'});
 const result=await f.runtime.manageGrok(f.thread,f.project,{operation:'memory.preview',arguments:{path:'/native-memory.md'}});
 const hash=/expectedContentHash: ([a-f0-9]{64})/.exec(result.rows[0]!.detail)![1]!;
 const op={operation:'memory.forget',arguments:{path:'/native-memory.md',expectedContentHash:hash},confirmed:true};
 await f.runtime.manageGrok(f.thread,f.project,op);
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,op),{code:'GROK_MEMORY_PREVIEW_REQUIRED'});
 assert.equal(f.requests.filter(r=>r.method==='_x.ai/memory/forget').length,1);
});
test('Grok rewind respects checkpoint scope and never forces file conflicts',async t=>{
 const f=await fixture(t,'grok');
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'rewind.execute',arguments:{targetPromptIndex:1,mode:'all'},confirmed:true}),{code:'GROK_TARGET_CHANGED'});
 await f.runtime.manageGrok(f.thread,f.project,{operation:'rewind.execute',arguments:{targetPromptIndex:1,mode:'conversation_only'},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/rewind/execute')?.params,{sessionId:'synthetic-session',targetPromptIndex:1,mode:'conversation_only',force:false});
});
test('Grok MCP form waits for explicit input and returns the native primitive result',async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,'grok-form');
 await until(()=>f.approvals.length===1);assert.equal(f.events.some(e=>e.type==='turn.completed'),false);
 assert.equal(f.approvals[0]?.method,'item/tool/requestUserInput');
 await f.runtime.respondInput(f.approvals[0]!,{enabled:{answers:['false']}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const item=f.events.find(e=>e.type==='item.completed'&&(e.payload.item as {type?:string}|undefined)?.type==='agentMessage')?.payload.item as {text?:string}|undefined;assert.deepEqual(JSON.parse(String(item?.text)),{outcome:'accept',content:{enabled:false}});
});

test('Grok native background work fences environment changes even after the foreground turn ends',async t=>{
 const f=await fixture(t,'grok');await f.children[0]!.call('_test/background',{active:true});
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'session.compact',arguments:{},confirmed:true}),{code:'HOST_BUSY'});
 assert.equal(f.requests.some(r=>r.method==='_x.ai/compact_conversation'),false);
 await f.runtime.manageGrok(f.thread,f.project,{operation:'task.stop',arguments:{taskId:'owned-task'},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/task/kill')?.params,{sessionId:'synthetic-session',taskId:'owned-task'});
});

test('Grok goals wait for the new handshake and context windows use the selected native model',async t=>{
 const f=await fixture(t,'grok');await f.runtime.unsubscribeThread(f.thread.nativeThreadId);f.runtime.availability.commands=[];
 await f.runtime.startTurn(f.thread,f.project,'do the task',undefined,{model:'grok-4',contextWindow:500000},undefined,{goal:'Finish the synthetic task'});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.deepEqual(f.requests.find(r=>r.method==='session/set_model')?.params,{sessionId:'synthetic-session',modelId:'grok-4',_meta:{contextWindow:500000}});
 assert.deepEqual((f.requests.find(r=>r.method==='session/prompt')?.params as {prompt:unknown}).prompt,[{type:'text',text:'/goal Finish the synthetic task\ndo the task'}]);
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'do not send',undefined,{model:'grok-4',contextWindow:123456}),{code:'GROK_OPTION_UNAVAILABLE'});
 assert.equal(f.requests.filter(r=>r.method==='session/prompt').length,1);
});
test('Grok startup settings apply to new sessions and never overwrite a resumed native session',async t=>{
 const f=await fixture(t,'grok');await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 await f.runtime.createThread(f.project,undefined,undefined,{rules:'Keep changes focused',agentProfile:'reviewer'});
 const creations=f.requests.filter(r=>r.method==='session/new');assert.deepEqual((creations.at(-1)?.params as {_meta:unknown})._meta,{rules:'Keep changes focused',agentProfile:'reviewer'});
 await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{rules:'Never replace existing instructions'});await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(Object.hasOwn(f.requests.find(r=>r.method==='session/load')?.params as object,'_meta'),false);
});

test('worktree operations bind native ownership and project root; merges never overwrite conflicts',async t=>{
 const f=await fixture(t,'grok'),path=join(f.project.root,'worktree');await mkdir(path);
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'worktrees.apply',arguments:{worktreePath:'/another/project'},confirmed:true}),{code:'GROK_TARGET_CHANGED'});
 assert.equal(f.requests.some(r=>r.method==='_x.ai/git/worktree/apply'),false);
 await f.runtime.manageGrok(f.thread,f.project,{operation:'worktrees.diff',arguments:{worktreePath:path}});
 assert.equal((f.requests.find(r=>r.method==='_x.ai/git/diffs')?.params as {gitRoot:string}).gitRoot,path);
 await f.runtime.manageGrok(f.thread,f.project,{operation:'worktrees.apply',arguments:{worktreePath:path},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/git/worktree/apply')?.params,{sessionId:'synthetic-session',worktreePath:path,mode:'merge'});
 await f.runtime.manageGrok(f.thread,f.project,{operation:'git.commit',arguments:{message:'Explicit synthetic commit'},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/git/commit')?.params,{sessionId:'synthetic-session',message:'Explicit synthetic commit',amend:false,push:false,sync:false,signoff:false});
});
test('subagent results cannot disclose another parent session',async t=>{
 const f=await fixture(t,'grok');
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'subagent.get',arguments:{subagentId:'another-child'}}),{code:'GROK_TARGET_CHANGED'});
 const result=await f.runtime.manageGrok(f.thread,f.project,{operation:'subagent.get',arguments:{subagentId:'owned-child'}});
 assert.equal(result.rows[0]?.status,'completed');assert.match(result.rows[0]!.detail,/output: result/);
});

test('Grok prompts preserve native search defaults unless the user explicitly changes or clears them',async t=>{
 const f=await fixture(t,'grok');
 for(const settings of [undefined,{xSearch:{fromDate:'2026-10-01'}},{xSearch:null}]){
  const n=f.events.filter(e=>e.type==='turn.completed').length;
  await f.runtime.startTurn(f.thread,f.project,'hello',undefined,settings);await until(()=>f.events.filter(e=>e.type==='turn.completed').length===n+1);
 }
 const params=f.requests.filter(r=>r.method==='session/prompt').map(r=>r.params as Record<string,unknown>);
 assert.equal(params[0]!._meta,undefined);
 assert.deepEqual(params[1]!._meta,{toolOverrides:{xSearch:{dateBound:{fromDate:'2026-10-01'}}}});
 assert.deepEqual(params[2]!._meta,{toolOverrides:{xSearch:null}});
});


test('Grok restores auto permissions on each new connection and explicit default clears them',async t=>{
 const f=await fixture(t,'grok');
 for(const mode of ['auto','default'] as const){
  await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
  await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{permissionMode:mode,mode:'default'});
  await until(()=>f.events.filter(e=>e.type==='turn.completed').length===(mode==='auto'?1:2));
  const request=f.requests.filter(r=>r.method==='_x.ai/yolo_mode_changed').at(-1)!;
  assert.deepEqual(request.params,{yolo_mode:false,auto_mode:mode==='auto',permission_mode:mode==='auto'?'auto':'ask'});
  assert.ok(f.launches.at(-1)?.includes('--no-leader'));
  const state=f.events.filter(e=>e.type==='turn.completed').at(-1)?.payload.grokState as Record<string,unknown>;
  assert.equal(state.permissionRequested,mode);assert.equal(state.permissionStatus,'requested');assert.equal(state.mode,'default');
 }
 assert.ok(f.requests.filter(r=>r.method==='session/load').every(r=>!r.params._meta));
});
test('verified Grok permission changes reconnect only when crossing always-allow',async t=>{
 const f=await fixture(t,'grok');
 const base=f.counts.connections;
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{permissionMode:'auto'});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 const kept=f.counts.connections;
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{permissionMode:'default'});
 await until(()=>f.events.filter(e=>e.type==='turn.completed').length===2);
 assert.equal(f.counts.connections,kept);
 assert.equal(f.counts.connections,base);
 const notices=f.requests.filter(r=>r.method==='_x.ai/yolo_mode_changed');
 assert.deepEqual(notices.map(r=>r.params.permission_mode),['auto','ask']);
 const beforeAlways=f.counts.connections;
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{permissionMode:'always'});
 await until(()=>f.events.filter(e=>e.type==='turn.completed').length===3);
 assert.ok(f.counts.connections>beforeAlways);
 assert.ok(f.launches.at(-1)?.includes('--always-approve'));
 const beforeUnset=f.counts.connections;
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{mode:'default'});
 await until(()=>f.events.filter(e=>e.type==='turn.completed').length===4);
 assert.ok(f.counts.connections>beforeUnset);
 assert.equal(f.launches.at(-1)?.includes('--always-approve'),false);
 const notified=f.requests.filter(r=>r.method==='_x.ai/yolo_mode_changed').length;
 await f.runtime.startTurn(f.thread,f.project,'hello');
 await until(()=>f.events.filter(e=>e.type==='turn.completed').length===5);
 assert.equal(f.requests.filter(r=>r.method==='_x.ai/yolo_mode_changed').length,notified);
 assert.equal(f.counts.connections,beforeUnset+1);
});
test('Grok never sends a prompt after an unconfirmed model or rejected plan switch',async t=>{
 const f=await fixture(t,'grok');
 await f.children[0]!.call('_test/control',{ignoreConfig:true});
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{model:'grok-4.6'}),{code:'GROK_CONFIG_UNCONFIRMED'});
 await f.children[0]!.call('_test/control',{invalidMode:true});
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{mode:'plan'}),{code:'GROK_CONFIG_UNCONFIRMED'});
 await f.children[0]!.call('_test/control',{rejectMode:true});
 await assert.rejects(f.runtime.startTurn(f.thread,f.project,'hello',undefined,{mode:'plan'}),{code:'ACP_REMOTE_ERROR'});
 assert.equal(f.requests.some(r=>r.method==='session/prompt'),false);
});
test('Grok extended controls bind listed skills, MCP servers and tools to the owned session',async t=>{
 const f=await fixture(t,'grok');
 const manage=(operation:string,args:Record<string,string>)=>f.runtime.manageGrok(f.thread,f.project,{operation,arguments:args,confirmed:true});
 await manage('skills.disable',{skillName:'owned-skill'});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/skills/toggle')?.params,{cwd:f.project.root,name:'owned-skill',enabled:false});
 await assert.rejects(manage('skills.enable',{skillName:'foreign'}),{code:'GROK_TARGET_CHANGED'});
 await manage('mcp.disable',{serverName:'owned-server'});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/mcp/toggle')?.params,{session_id:'synthetic-session',server_name:'owned-server',enabled:false});
 await manage('mcp.tool.enable',{serverName:'owned-server',toolName:'owned-tool'});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/mcp/toggle_tool')?.params,{session_id:'synthetic-session',server_name:'owned-server',tool_name:'owned-tool',enabled:true});
 await assert.rejects(manage('mcp.tool.disable',{serverName:'owned-server',toolName:'foreign'}),{code:'GROK_TARGET_CHANGED'});
 await assert.rejects(manage('mcp.disable',{serverName:'foreign'}),{code:'GROK_TARGET_CHANGED'});
 const workflows=await f.runtime.manageGrok(f.thread,f.project,{operation:'workflows.list',arguments:{}});
 assert.ok(workflows.rows.some(r=>r.name==='review'));
});
test('Grok staging never stages a directory or an implicit whole repository',async t=>{
 const f=await fixture(t,'grok');await writeFile(join(f.project.root,'one.txt'),'one');await mkdir(join(f.project.root,'directory'));
 await f.runtime.manageGrok(f.thread,f.project,{operation:'git.stage',arguments:{filePath:'one.txt'},confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/git/stage')?.params,{sessionId:'synthetic-session',gitRoot:f.project.root,paths:['one.txt']});
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'git.stage',arguments:{filePath:'directory'},confirmed:true}),{code:'GROK_TARGET_CHANGED'});
});
test('Grok file inspection bounds native pages and rejects symlinks outside the workspace',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t,'grok');await writeFile(join(f.project.root,'note.txt'),'note');
 await symlink(tmpdir(),join(f.project.root,'outside'));
 await f.runtime.manageGrok(f.thread,f.project,{operation:'files.list',arguments:{filePath:'.',offset:50}});
 assert.deepEqual(f.requests.find(r=>r.method==='_x.ai/fs/list')?.params,{sessionId:'synthetic-session',path:f.project.root,offset:50,depth:1,limit:50,followSymlinks:false,respectGitIgnore:true});
 await f.runtime.manageGrok(f.thread,f.project,{operation:'files.read',arguments:{filePath:'note.txt',offset:0}});
 assert.equal(f.requests.find(r=>r.method==='_x.ai/fs/read_file')?.params.maxBytes,4000);
 await assert.rejects(f.runtime.manageGrok(f.thread,f.project,{operation:'files.list',arguments:{filePath:'outside',offset:0}}),{code:'GROK_TARGET_CHANGED'});
});

test('image interjections are verified for 1.0.70 without enabling unknown versions',async t=>{
 assert.equal(grokImageInterjection('grok 1.0.70 (build)',true),true);
 assert.equal(grokImageInterjection('grok 1.0.62 (build)',true),true);
 assert.equal(grokImageInterjection('grok 1.0.71 (build)',true),false);
 assert.equal(grokImageInterjection('grok 1.0.70 (build)',false),false);
 const f=await fixture(t,'grok',true);
 const turn=await f.runtime.startTurn(f.thread,f.project,'wait');
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 await f.runtime.steerTurn(f.thread,turn.nativeTurnId,'image','image-message',[image]);
 assert.equal((f.requests.filter(r=>r.method==='_x.ai/interject').at(-1)?.params.content as {type:string}[])[1]?.type,'image');
 await f.runtime.steerTurn(f.thread,turn.nativeTurnId,'finish');await until(()=>f.events.some(e=>e.type==='turn.completed'));
});

for(const [answer,result] of [
 ['批准计划并开始执行',{outcome:'approved'}],['暂不执行，继续计划',{outcome:'cancelled'}],
 ['放弃本次计划',{outcome:'abandoned'}],['Add error handling',{outcome:'cancelled',feedback:'Add error handling'}],
] as const)test(`Grok plan review requires explicit consent: ${answer}`,async t=>{
 const f=await fixture(t,'grok');
 await f.runtime.startTurn(f.thread,f.project,'grok-plan',undefined,{mode:'plan',permissionMode:'always'});
 await until(()=>f.approvals.length===1);
 const approval=f.approvals[0]!;
 assert.equal(approval.method,'item/tool/requestUserInput');assert.match(String(approval.params.planContent),/Create hello.txt/);
 assert.equal(f.events.some(e=>e.type==='turn.completed'),false,'Always-approve must not approve implementation');
 await assert.rejects(f.runtime.respondApproval(approval,'accept'),{code:'INPUT_REQUIRED'});
 await assert.rejects(f.runtime.respondInput({...approval,actionHash:'changed'},{grok_plan_review:{answers:[answer]}}),{code:'APPROVAL_STALE'});
 await f.runtime.respondInput(approval,{grok_plan_review:{answers:[answer]}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string}|undefined)?.text===JSON.stringify(result)));
 assert.equal((f.events.find(e=>e.type==='turn.completed')?.payload.grokState as {mode?:string}).mode,answer==='批准计划并开始执行'||answer==='放弃本次计划'?'default':'plan');
 await assert.rejects(f.runtime.respondInput(approval,{grok_plan_review:{answers:[answer]}}),{code:'APPROVAL_STALE'});
});
for(const prompt of ['grok-plan-large','grok-plan-empty'])test(`Grok refuses approval without a complete bounded plan: ${prompt}`,async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,prompt);
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.approvals.length,0);
 assert.ok(f.events.some(e=>e.type==='item.completed'&&String((e.payload.item as {text?:string}|undefined)?.text).includes('"outcome":"cancelled"')));
});
test('Grok plan cancellation returns native cancelled and invalidates pending consent',async t=>{
 const f=await fixture(t,'grok');const turn=await f.runtime.startTurn(f.thread,f.project,'grok-plan');
 await until(()=>f.approvals.length===1);await f.runtime.interruptTurn(f.thread.nativeThreadId,turn.nativeTurnId);
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 await assert.rejects(f.runtime.respondInput(f.approvals[0]!,{grok_plan_review:{answers:['批准计划并开始执行']}}),{code:'APPROVAL_STALE'});
});

for(const [answer,result] of [['SQLite',{outcome:'accepted',answers:{'Which database?':['SQLite']}}],['Postgres',{outcome:'accepted',answers:{'Which database?':['Other']},annotations:{'Which database?':{notes:'Postgres'}}}]] as const)test(`Grok interview preserves native question keys and freeform annotations: ${answer}`,async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,'grok-question',undefined,{permissionMode:'auto'});
 await until(()=>f.approvals.length===1);
 await f.runtime.respondInput(f.approvals[0]!,{grok_question_0:{answers:[answer]}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text===JSON.stringify(result)));
});
test('Grok interview treats a null multi-select flag as unset and still shows the question',async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,'grok-question-null');
 await until(()=>f.approvals.length===1);
 assert.equal((f.approvals[0]!.params.questions as Array<{multi?:boolean}>)[0]?.multi,undefined);
 await f.runtime.respondInput(f.approvals[0]!,{grok_question_0:{answers:['SQLite']}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text===JSON.stringify({outcome:'accepted',answers:{'Which database?':['SQLite']}})));
});
test('Grok multi-select interview returns chosen labels and one free-text note',async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,'grok-question-multi');
 await until(()=>f.approvals.length===1);
 assert.equal((f.approvals[0]!.params.questions as Array<{multi?:boolean}>)[0]?.multi,true);
 await f.runtime.respondInput(f.approvals[0]!,{grok_question_0:{answers:['SQLite','Postgres','My own database']}});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text===JSON.stringify({outcome:'accepted',answers:{'Which databases?':['SQLite','Postgres','Other']},annotations:{'Which databases?':{notes:'My own database'}}})));
});
test('Grok interview option previews are cancelled instead of answered',async t=>{
 const f=await fixture(t,'grok');await f.runtime.startTurn(f.thread,f.project,'grok-question-preview');
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.approvals.length,0);
 assert.ok(f.events.some(e=>e.type==='item.completed'&&String((e.payload.item as {text?:string}|undefined)?.text).includes('"outcome":"cancelled"')));
});

test('unverified Grok versions cannot silently ignore explicit auto or ask-mode requests',async t=>{
 const f=await fixture(t,'grok',false,0,'grok 1.0.71 (unverified)');
 for(const permissionMode of ['default','auto'] as const)await assert.rejects(f.runtime.startTurn(f.thread,f.project,'must not run',undefined,{permissionMode}),{code:'GROK_PERMISSION_UNAVAILABLE'});
 assert.equal(f.requests.some(r=>r.method==='session/prompt'),false);
 await f.runtime.startTurn(f.thread,f.project,'hello');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.requests.some(r=>r.method==='_x.ai/yolo_mode_changed'),false,'No native-setting override is inferred');
});

test('Grok accepts a successful mode acknowledgement before its asynchronous mode notification',async t=>{
 const f=await fixture(t,'grok');await f.children[0]!.call('_test/control',{deferredMode:true});
 await f.runtime.startTurn(f.thread,f.project,'hello',undefined,{mode:'default'});
 await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.ok(f.requests.some(r=>r.method==='session/set_mode'&&r.params.modeId==='default'));
 assert.equal((f.events.find(e=>e.type==='turn.completed')?.payload.grokState as {mode:string}).mode,'default');
});
