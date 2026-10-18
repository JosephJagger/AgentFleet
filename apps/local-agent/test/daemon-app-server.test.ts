import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServer,type AppServerCallbacks} from '../src/app-server.js';
import {resolveProject} from '../src/projects.js';
import type {ManagedThread,ApprovalRecord} from '../src/types.js';

async function fixture(t:import('node:test').TestContext){
  const cwd=await mkdtemp(join(tmpdir(),'daemon-app-test-'));
  const project=await resolveProject(cwd,'fixture');
  const thread={nativeThreadId:'target',projectId:project.id,sessionCwd:cwd,appServerEpoch:'epoch',policyVerified:true,permissionProfile:'full'} as ManagedThread;
  const approvals:ApprovalRecord[]=[];const events:unknown[]=[];const wire:Record<string,any>[]=[];
  let state='idle',closed=0,injectRequests=false,observedPolicy='never';
  const callbacks:AppServerCallbacks={findManagedThread:id=>id==='target'?thread:undefined,findProject:()=>project,onEvent:async e=>{events.push(e);},onVolatile:()=>{},onApproval:async a=>{approvals.push(a);},onApprovalResolved:async()=>{},onExit:async()=>{}};
  const server=new CodexAppServer(callbacks,'epoch',{}, {daemonThreadId:'target'});
  const internal=server as unknown as {initialized:boolean;daemon:unknown;handleLine(s:string):Promise<void>;handleExit(s:string):void;request(m:string,p:Record<string,unknown>):Promise<unknown>};
  internal.initialized=true;
  const rawThread=()=>({id:'target',cwd,status:{type:state},historyMode:'legacy',turns:[]});
  const request=(id:number,target:string,turnId:string)=>({id,method:'item/commandExecution/requestApproval',params:{threadId:target,turnId,itemId:'item-'+id,command:'synthetic',cwd}});
  internal.daemon={close:async()=>{closed++;internal.handleExit('test close');},send:async(line:string)=>{
    const m=JSON.parse(line);wire.push(m);if(!m.method)return;
    let result:unknown={};
    if(m.method==='thread/read')result={thread:rawThread()};
    if(m.method==='thread/resume')result={thread:rawThread(),cwd,approvalPolicy:observedPolicy,sandbox:{type:'dangerFullAccess'}};
    if(m.method==='turn/start'){
      if(injectRequests){
        await internal.handleLine(JSON.stringify(request(801,'target','ours')));
        await internal.handleLine(JSON.stringify(request(802,'target','foreign')));
        await internal.handleLine(JSON.stringify(request(803,'unrelated','ours')));
        assert.equal(approvals.length,0,'No approval before exact native turn identity');
      }
      result={turn:{id:'ours',status:'inProgress'}};
    }
    await internal.handleLine(JSON.stringify({id:m.id,result}));
  }};
  t.after(async()=>{await server.stop();await rm(cwd,{recursive:true,force:true});});
  return {server,internal,thread,project,wire,approvals,events,request,closed:()=>closed,setState:(v:string)=>{state=v;},inject:()=>{injectRequests=true;},setPolicy:(v:string)=>{observedPolicy=v;}};
}

test('shared resume preserves identity and verifies returned permissions, then only detaches its client',async t=>{
  const f=await fixture(t);
  assert.equal((await f.server.resumeThread('target',f.project,undefined,'full')).policyVerified,true);
  f.setPolicy('on-request');
  assert.equal((await f.server.resumeThread('target',f.project,undefined,'full')).policyVerified,false,'Ignored native overrides cannot become grants');
  assert.equal(f.server.getProcessId(),undefined,'A shared socket is never a voice process identity');
  await assert.rejects(f.server.resumeThread('other',f.project),{code:'THREAD_READ_ONLY'});
  await assert.rejects(f.server.resumeThread('target',f.project,undefined,'full',true,true),{code:'THREAD_READ_ONLY'});
  await f.server.releaseWriter();
  assert.equal(f.closed(),1);
  assert.equal(f.wire.filter(m=>m.method==='thread/unsubscribe').length,1);
  assert.equal(f.wire.some(m=>m.method==='thread/loaded/list'),false,'Does not inspect or stop unrelated daemon work');
});

test('known native activity prevents resume and a fresh pre-send check prevents starting or steering it',async t=>{
  const f=await fixture(t);f.setState('active');
  await assert.rejects(f.server.resumeThread('target',f.project,undefined,'full'),{code:'THREAD_BUSY'});
  await assert.rejects(f.server.startTurn(f.thread,f.project,'authorized new task'),{code:'THREAD_BUSY'});
  assert.equal(f.wire.some(m=>m.method==='thread/resume'||m.method==='turn/start'),false);
});

test('shared dispatch sends once and only forwards approvals matching the confirmed turn',async t=>{
  const f=await fixture(t);f.inject();
  const result=await f.server.startTurn(f.thread,f.project,'authorized new task');
  assert.equal(result.nativeTurnId,'ours');assert.equal(f.wire.filter(m=>m.method==='turn/start').length,1);
  assert.equal(f.approvals.length,1);assert.equal(f.approvals[0]!.nativeTurnId,'ours');
  assert.equal(f.wire.some(m=>[802,803].includes(m.id)),false,'Never decline another client request');
  await assert.rejects(f.server.interruptTurn('target','foreign'),{code:'THREAD_READ_ONLY'});
  await f.server.interruptTurn('target','ours');
  assert.equal(f.wire.filter(m=>m.method==='turn/interrupt').length,1);
});

test('shared transport refuses global maintenance and mutation of another thread before writing',async t=>{
  const f=await fixture(t);
  for(const method of ['thread/archive','thread/delete','thread/realtime/start','config/batchWrite','mcpServer/reload']){
    await assert.rejects(f.internal.request(method,{threadId:'target'}));
  }
  await assert.rejects(f.internal.request('turn/start',{threadId:'other'}),{code:'THREAD_READ_ONLY'});
  assert.equal(f.wire.length,0);
  await f.internal.handleLine(JSON.stringify(f.request(901,'other','ours')));
  assert.equal(f.wire.length,0);
});


test('shared writer release preserves tracking while its target is active',async t=>{
  const f=await fixture(t);
  await f.server.resumeThread('target',f.project,undefined,'full');
  f.setState('active');
  await assert.rejects(f.server.releaseWriter(),{code:'THREAD_RELEASE_PENDING'});
  assert.equal(f.closed(),0);
  assert.equal(f.wire.some(m=>m.method==='thread/unsubscribe'),false);
  f.setState('idle');
  await f.server.releaseWriter();
  assert.equal(f.closed(),1);
});
