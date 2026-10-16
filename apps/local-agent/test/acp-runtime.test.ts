import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcpRuntime} from '../src/acp-runtime.js';
import {AcpConnection} from '../src/acp-connection.js';
import {ACP_PROVIDER_IDS} from '../src/provider-catalog.js';
import type {AppServerCallbacks,AppEvent} from '../src/app-server.js';
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
 case 'initialize':send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}}}}});break;
 case 'session/list':send({id:m.id,result:{sessions:[{sessionId,cwd:process.cwd(),title:'Synthetic'}]}});break;
 case 'session/new':send({id:m.id,result:{sessionId}});break;
 case 'session/load':send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Retained history'}}}});send({id:m.id,result:{}});break;
 case 'session/prompt':
   promptId=m.id;requestKind=m.params.prompt[0].text;
   if(requestKind==='disconnect'){process.exit(7);return;}
   if(requestKind==='wait')return;
   if(requestKind==='permission'){send({id:991,method:'session/request_permission',params:{sessionId,toolCall:{title:'Synthetic write'},options:[{optionId:'one',kind:'allow_once'},{optionId:'all',kind:'allow_always'},{optionId:'no',kind:'reject_once'}]}});return;}
   if(requestKind==='question'){send({id:991,method:'cursor/ask_question',params:{toolCallId:'q',questions:[{id:'q1',prompt:'Choose',options:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]}]}});return;}
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello '}}}});
   send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'世界'}}}});
   send({id:m.id,result:{stopReason:'end_turn'}});break;
 case 'session/cancel':send({id:promptId,result:{stopReason:'cancelled'}});break;
 }
});`;
async function fixture(t: TestContext,provider: typeof ACP_PROVIDER_IDS[number]='qwen') {
 const dir=await mkdtemp(join(tmpdir(),'acp-test-'));const file=join(dir,'peer.cjs');await writeFile(file,peer);
 const events:AppEvent[]=[];const approvals:ApprovalRecord[]=[];const exits:string[]=[];
 const project:ProjectRecord={id:'project-test',alias:'synthetic',provider,root:dir,device:'test',inode:'test',identityVersion:1,addedAt:new Date().toISOString()};
 let thread:ManagedThread|undefined;
 const callbacks:AppServerCallbacks={findManagedThread:id=>thread?.nativeThreadId===id?thread:undefined,findProject:()=>project,onEvent:async e=>{events.push(e);},onVolatile:()=>{},onApproval:async a=>{approvals.push(a);},onApprovalResolved:async()=>{},onExit:async()=>{},onThreadExit:async id=>{exits.push(id);}};
 const counts={connections:0};
 const runtime=new AcpRuntime(provider,callbacks,'epoch-test',{detect:async()=>({executable:process.execPath,prefix:[file],version:'synthetic-1.0.0'}),unoccupied:async()=>{},connection:options=>{counts.connections++;return new AcpConnection(options);}});
 t.after(async()=>{await runtime.stop();await rm(dir,{recursive:true,force:true});});
 await runtime.start();const created=await runtime.createThread(project);
 thread={nativeThreadId:created.nativeThreadId,projectId:project.id,appServerEpoch:'epoch-test',policyVersion:'remote-restricted-v1',policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString(),historyMode:'legacy'} as ManagedThread;
 return {runtime,thread,project,events,approvals,exits,counts};
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
