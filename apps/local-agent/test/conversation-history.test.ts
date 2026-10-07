import test from 'node:test';
import assert from 'node:assert/strict';
import {readConversation} from '../src/conversation-history.js';
const user={id:'u',type:'userMessage',content:[{type:'text',text:'Question'}]};
const final={id:'a',type:'agentMessage',phase:'final_answer',text:'Answer'};
test('legacy idle history uses only thread/read, preserves turns, and pages older dialogue',async()=>{
 const calls:Record<string,unknown>[]=[];
 const rpc=async(method:string,params:Record<string,unknown>)=>{assert.equal(method,'thread/read');calls.push(params);return {thread:{id:'t',cwd:'/project',historyMode:'legacy',turns:params.includeTurns?[{id:'old',status:'completed',items:[{...user,id:'old-u'}]},{id:'new',status:'completed',startedAt:123,items:[user,final]}]:[]}};};
 const latest=await readConversation(rpc,'t',null);assert.deepEqual(latest.items.map(i=>i.text),['Question','Answer']);assert.equal(latest.items[1]?.phase,'final_answer');assert.equal(latest.items[0]?.time,123);assert.equal(latest.items[0]?.timeSource,'native_turn');
 const older=await readConversation(rpc,'t',latest.nextCursor);assert.equal(older.turnId,'old');assert.equal(older.nextCursor,null);assert.equal(calls.length,4);
});
test('paginated stores request full persisted items without loading/resuming a task',async()=>{
 const rpc=async(method:string,params:Record<string,unknown>)=>{
  if(method==='thread/read'){assert.equal(params.includeTurns,false);return {thread:{id:'t',cwd:'/project',historyMode:'paginated'}};}
  assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'full');assert.equal(params.sortDirection,'desc');assert.equal(params.limit,1);
  return {data:[{id:params.cursor?'old':'new',status:'completed',items:[user,final]}],nextCursor:params.cursor?null:'older'};
 };
 const latest=await readConversation(rpc,'t',null),older=await readConversation(rpc,'t',latest.nextCursor);assert.equal(older.turnId,'old');assert.equal(older.nextCursor,null);
});
test('long messages and large turns remain completely readable through explicit chunks',async()=>{
 const long='abc'.repeat(21000),items=[user,{...final,text:long},...Array.from({length:25},(_,n)=>({...final,id:`a${n}`,text:`reply${n}`}))];
 const rpc=async()=>({thread:{id:'t',cwd:'/project',turns:[{id:'turn',status:'completed',items}]}});
 let cursor:string|null=null;const chunks:string[]=[];const ids:string[]=[];let pages=0;
 do{const page=await readConversation(rpc,'t',cursor);for(const item of page.items){if(item.id==='a')chunks.push(item.text);else ids.push(item.id);}cursor=page.nextCursor;assert.ok(++pages<10);}while(cursor);
 assert.equal(chunks.join(''),long);assert.equal(new Set(ids).size,26);
});
test('identity changes, malformed cursors and unloaded native items fail closed',async()=>{
 await assert.rejects(readConversation(async()=>({thread:{id:'other',cwd:'/project'}}),'t',null),{code:'HISTORY_TARGET_CHANGED'});
 await assert.rejects(readConversation(async()=>({}),'t','bad'),{code:'HISTORY_CURSOR_INVALID'});
 await assert.rejects(readConversation(async method=>method==='thread/read'?{thread:{id:'t',cwd:'/project',historyMode:'paginated'}}:{data:[],nextCursor:'more'},'t',null),{code:'HISTORY_INVALID'});
});

import {AgentRuntime} from '../src/runtime.js';
import {SessionAppServer} from '../src/session-app-server.js';
import type {AppServerCallbacks,AppServerClient} from '../src/app-server.js';
test('session facade uses its existing read-only catalog and creates no session writer',async()=>{
 let factories=0,reads=0;
 const client={readConversation:async()=>{reads++;return {nativeThreadId:'t',cwd:'/project',turnId:null,turnStatus:null,items:[],nextCursor:null,truncated:false,source:'codex_app_server'};}};
 const facade=new SessionAppServer({} as AppServerCallbacks,()=>{factories++;return client as unknown as AppServerClient;});
 await facade.readConversation('t',null);assert.equal(factories,1);assert.equal(reads,1);
});
test('runtime checks exact binding, cwd, permissions and connection before and after a read',async()=>{
 const binding={nativeThreadId:'t',logicalSessionId:'s',executionSegmentId:'seg',contentEpoch:1,codexProfileId:'profile',projectId:'p'};
 const state={nativeThreadBindings:{t:binding},projects:[{id:'p',root:'/project'}],projectContentPolicies:{p:{syncContent:true}},managedThreads:{},discoveredThreads:{}};
 let reads=0,change=false;const activities:boolean[]=[];
 const runtime=Object.assign(Object.create(AgentRuntime.prototype),{support:{readable:true,codexProfile:{id:'profile'}},transportGeneration:1,producerEpoch:'prod',store:{snapshot:()=>structuredClone(state),setAuxiliaryActivity:(_id:string,on:boolean)=>activities.push(on)},appServer:{appServerEpoch:'epoch',readConversation:async()=>{reads++;if(change)state.projectContentPolicies.p.syncContent=false;return {nativeThreadId:'t',cwd:'/project',items:[]};}}}) as AgentRuntime;
 const target={...binding,projectExternalId:'p',transportGeneration:1,producerEpoch:'prod',appServerEpoch:'epoch',cursor:null,requestId:'r'};
 await assert.rejects(runtime.readSessionConversation({...target,logicalSessionId:'other'}),{code:'HISTORY_TARGET_CHANGED'});assert.equal(reads,0);
 await runtime.readSessionConversation(target);assert.equal(reads,1);assert.deepEqual(activities,[true,false]);
 change=true;await assert.rejects(runtime.readSessionConversation(target),{code:'HISTORY_TARGET_CHANGED'});assert.deepEqual(activities,[true,false,true,false]);
});

import {serializePanelToolResult} from '../src/panel-voice-tools.js';
test('voice tool preserves long history JSON and continuation cursors without slicing',()=>{
 const page={items:[{text:'x'.repeat(63000)}],nextCursor:'next-page'};
 assert.deepEqual(JSON.parse(serializePanelToolResult(page,true)),page);
 assert.equal(JSON.parse(serializePanelToolResult({text:'x'.repeat(500000)},true)).errorCode,'PANEL_RESULT_TOO_LARGE');
});
test('latest pair includes final reply even when context has more than one page',async()=>{
 const comments=Array.from({length:30},(_,n)=>({...final,id:`comment-${n}`,phase:'commentary',text:'Still working'}));
 const rpc=async()=>({thread:{id:'t',cwd:'/project',turns:[{id:'turn',status:'completed',items:[user,...comments,final]}]}});
 const page=await readConversation(rpc,'t',null);assert.equal(page.items.length,20);assert.deepEqual(page.latestMessages?.map(i=>i.text),['Question','Answer']);assert.ok(page.nextCursor);
});
