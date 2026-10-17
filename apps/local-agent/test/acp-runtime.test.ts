import {acpImageInput,acpImageBlocks} from '../src/acp-images.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcpRuntime} from '../src/acp-runtime.js';
import {AcpConnection} from '../src/acp-connection.js';
import {ACP_PROVIDER_IDS} from '../src/provider-catalog.js';
import type {AppServerCallbacks,AppEvent,VolatileAppEvent} from '../src/app-server.js';
import type {ApprovalRecord,ManagedThread,ProjectRecord} from '../src/types.js';

// A synthetic protocol peer, never a real user CLI or authenticated session.
const peer=String.raw`
const readline=require('node:readline');
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
let promptId, sessionId='synthetic-session', requestKind;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===991 && !m.method) { send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});send({id:promptId,result:{stopReason:'end_turn'}});return; }
 switch(m.method) {
 case 'initialize':send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:process.env.ACP_TEST_IMAGES==='yes'},sessionCapabilities:{list:{}}}}});break;
 case 'session/list':send({id:m.id,result:{sessions:[{sessionId,cwd:process.cwd(),title:'Synthetic'}]}});break;
 case 'session/new':send({id:m.id,result:{sessionId,configOptions:[{id:'model',options:['grok-4.6','grok-4'],currentValue:'grok-4'},{id:'reasoning_effort',options:['low','high'],currentValue:'low'}]}});break;
 case 'session/load':if(process.env.ACP_TEST_IMAGES==='yes')send({method:'session/update',params:{sessionId,update:{sessionUpdate:'user_message_chunk',content:{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}}}});send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Retained history'}}}});send({id:m.id,result:{configOptions:[{id:'model',options:['grok-4.6','grok-4'],currentValue:'grok-4'},{id:'reasoning_effort',options:['low','high'],currentValue:'low'}]}});break;
 case 'session/set_config_option':
   if(!['model','reasoning_effort','mode'].includes(m.params.configId)){process.exit(9);return;}
   send({id:m.id,result:{configOptions:[{id:m.params.configId,currentValue:m.params.value,options:[m.params.value]}]}});break;
 case 'session/prompt':
   promptId=m.id;requestKind=m.params.prompt[0].text;
   if(requestKind==='images'||requestKind===''){send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.params.prompt)}}}});send({id:m.id,result:{stopReason:'end_turn'}});return;}
   if(requestKind==='disconnect'){process.exit(7);return;}
   if(requestKind==='wait')return;
   if(requestKind==='permission'){send({id:991,method:'session/request_permission',params:{sessionId,toolCall:{title:'Synthetic write'},options:[{optionId:'one',kind:'allow_once'},{optionId:'all',kind:'allow_always'},{optionId:'no',kind:'reject_once'}]}});return;}
   if(requestKind==='question'){send({id:991,method:'cursor/ask_question',params:{toolCallId:'q',questions:[{id:'q1',prompt:'Choose',options:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]}]}});return;}
   if(requestKind==='burst'){
     for(let i=0;i<200;i++) send({method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',toolCallId:'t'+i,title:'T'+i,kind:'execute',status:'in_progress',rawInput:{command:'echo '+i}}}});
     send({id:m.id,result:{stopReason:'end_turn'}});return;
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
async function fixture(t: TestContext,provider: typeof ACP_PROVIDER_IDS[number]='qwen',images=false) {
 const dir=await mkdtemp(join(tmpdir(),'acp-test-'));const file=join(dir,'peer.cjs');await writeFile(file,peer);
 const events:AppEvent[]=[];const batches:AppEvent[][]=[];const volatiles:VolatileAppEvent[]=[];const approvals:ApprovalRecord[]=[];const exits:string[]=[];const launches:string[][]=[];const batchWatchers:Array<()=>void>=[];
 const project:ProjectRecord={id:'project-test',alias:'synthetic',provider,root:dir,device:'test',inode:'test',identityVersion:1,addedAt:new Date().toISOString()};
 let thread:ManagedThread|undefined;
 const callbacks:AppServerCallbacks={findManagedThread:id=>thread?.nativeThreadId===id?thread:undefined,findProject:()=>project,onEvent:async e=>{events.push(e);},onEvents:async batch=>{batches.push(batch);events.push(...batch);for(const watch of batchWatchers)watch();},onVolatile:e=>{volatiles.push(e);},onApproval:async a=>{approvals.push(a);},onApprovalResolved:async()=>{},onExit:async()=>{},onThreadExit:async id=>{exits.push(id);}};
 const counts={connections:0};
 const runtime=new AcpRuntime(provider,callbacks,'epoch-test',{detect:async()=>({executable:process.execPath,prefix:[file],version:'synthetic-1.0.0'}),unoccupied:async()=>{},connection:options=>{counts.connections++;launches.push(options.args);return new AcpConnection({...options,env:{...process.env,ACP_TEST_IMAGES:images?'yes':'no'}});}});
 t.after(async()=>{await runtime.stop();await rm(dir,{recursive:true,force:true});});
 await runtime.start();const created=await runtime.createThread(project);
 thread={nativeThreadId:created.nativeThreadId,projectId:project.id,appServerEpoch:'epoch-test',policyVersion:'remote-restricted-v1',policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString(),historyMode:'legacy'} as ManagedThread;
 return {runtime,thread,project,events,batches,batchWatchers,volatiles,approvals,exits,counts,launches};
}
async function until(predicate:()=>boolean){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw new Error('Synthetic protocol timed out');await new Promise(r=>setTimeout(r,5));}}
for(const provider of ACP_PROVIDER_IDS)test(`${provider}: native ID, streamed text, completion and history round trip`,async t=>{
 const f=await fixture(t,provider);const catalog=await f.runtime.listThreads();assert.equal(catalog[0]?.nativeThreadId,f.thread.nativeThreadId);
 const turn=await f.runtime.startTurn(f.thread,f.project,'hello');await until(()=>f.events.some(e=>e.type==='turn.completed'));
 assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
 assert.ok(f.events.some(e=>e.type==='item.completed'&&(e.payload.item as {text?:string})?.text==='Hello 世界'));
 assert.equal(f.events.at(-1)?.nativeTurnId,turn.nativeTurnId);
 await f.runtime.unsubscribeThread(f.thread.nativeThreadId);
 const resumed=await f.runtime.resumeThread(f.thread.nativeThreadId,f.project);assert.equal(resumed.history.items[0]?.item?.text,'Retained history');
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
test('grok reapplies a reported model and always-approve without inventing a task-mode option',async t=>{
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
