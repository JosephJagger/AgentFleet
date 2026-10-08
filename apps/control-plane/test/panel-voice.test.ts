import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {PanelVoiceService} from '../src/panel-voice.js';

function fixture() {
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'panel@example.test',ADMIN_PASSWORD:'panel-test-password',PUBLIC_ORIGIN:'http://panel.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const db=new ControlPlaneDatabase(':memory:');const {workspaceId}=db.bootstrap(config);
  const auth=new AuthService(db,config);const principal=auth.servicePrincipal('panel-test');
  const at=new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Mac','linux','24','x64','0.30.69','online','compatible','["turn.start"]',?,?,?)`,workspaceId,at,at,at);
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','p','Demo','/fixture','hash',?,?)",workspaceId,at,at);
  const registry=new RegistryService(db,config);const coordination=new CoordinationService(db,config);
  const session=registry.createSession(principal,'m','p','Test session','panel-fixture-session');
  const service=new PanelVoiceService(db,registry,coordination);
  const call=service.start(principal,'m',{});service.state(call.voice_id,'active');
  const dispatch=(request='request-one')=>service.tool(principal,call.voice_id,request,{action:'dispatch',sessionId:session.logicalSessionId,prompt:'Read project status'});
  return {db,auth,principal,registry,coordination,service,session,call,dispatch};
}

test('panel dispatch persists one real command, survives hangup, and deduplicates retries',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const first=f.dispatch() as {jobId:string};
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,1);
  assert.equal((f.dispatch() as {jobId:string}).jobId,first.jobId);
  assert.throws(()=>f.dispatch('request-two'),/已有任务/);
  f.service.closeOrphans();
  assert.equal(f.service.current(f.principal)?.job_id,first.jobId);
  const next=f.service.start(f.principal,'m',{});f.service.state(next.voice_id,'active');
  assert.throws(()=>f.service.tool(f.principal,next.voice_id,'request-new',{action:'dispatch',sessionId:f.session.logicalSessionId,prompt:'same'}),/已有任务/);
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,1);
});

test('panel job insertion failure rolls back the command and project reservation',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.db.sqlite.exec("CREATE TRIGGER reject_job BEFORE INSERT ON panel_voice_jobs BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  assert.throws(()=>f.dispatch(),/test rollback/);
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM project_turn_reservations')?.n,0);
});

test('panel honors browser ownership, current account authorization and existing session guards',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const other=f.auth.servicePrincipal('another-browser');
  assert.throws(()=>f.service.tool(other,f.call.voice_id,'r',{action:'status'}),/无权/);
  assert.throws(()=>f.service.start(f.principal,'m',{}),/已有面板/);
  assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'r',{action:'dispatch',sessionId:'forbidden',prompt:'do it'}));
  f.db.run("UPDATE logical_sessions SET reachability='reconciling'");
  assert.throws(()=>f.dispatch());
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
});

test('unknown command status blocks duplicate work instead of claiming completion',t=>{
  const f=fixture();t.after(()=>f.db.close());f.dispatch();
  f.db.run("UPDATE command_projection SET state='unknown'");
  assert.equal(f.service.current(f.principal)?.state,'unknown');
  assert.equal(f.service.report(f.principal,f.call.voice_id),null);
  assert.throws(()=>f.dispatch('retry-new'),/已有任务/);
});

test('completion follows the exact native turn; deleted content is never spoken or inferred as success',t=>{
  const f=fixture();t.after(()=>f.db.close());f.dispatch();
  const job=f.service.current(f.principal)!;
  const event=(seq:number,type:string,body:unknown,turn='native-task')=>{
    const ref=`payload-${seq}`,at=new Date().toISOString();
    f.db.run("INSERT INTO content_blobs VALUES(?,?,?,?,?,? ,NULL)",ref,f.principal.workspaceId,JSON.stringify(body),'hash',at,'9999-12-31T00:00:00Z');
    f.db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state) VALUES(?,'hash','agent',?,?,?,'m','p',?,1,'native',?,?,'1',?,?,?,'present')`, `event-${seq}`,f.principal.workspaceId,f.session.logicalSessionId,f.session.executionSegmentId,seq,turn,type,at,at,ref);
  };
  event(1,'turn.started',{commandId:job.command_id});
  event(2,'turn.completed',{turn:{status:'completed'}},'different-turn');
  assert.equal(f.service.current(f.principal)?.state,'running');
  event(3,'item.completed',{item:{type:'agentMessage',text:'Verified deployment result'}});
  event(4,'turn.completed',{turn:{status:'completed'}});
  const report=f.service.report(f.principal,f.call.voice_id)!;
  assert.equal(report.result.result,'Verified deployment result');
  assert.equal(report.result.executionStarted,true);
  assert.equal(report.result.historyLimited,false);
  f.service.acknowledgeReport(f.call.voice_id,report.reportId);
  assert.equal(f.service.report(f.principal,f.call.voice_id),null);
  f.db.run("UPDATE content_blobs SET deleted_at='now' WHERE payload_ref='payload-3'");
  assert.equal(f.service.describe(f.principal,f.service.current(f.principal)!).result,'');
  assert.equal(f.service.describe(f.principal,f.service.current(f.principal)!).historyLimited,true);
  f.db.run("UPDATE content_blobs SET body_json='{}' WHERE payload_ref='payload-4'");
  assert.equal(f.service.current(f.principal)?.state,'completed','confirmed terminal state survives content expiration');
});

test('panel diagnostics retain the first safe cause even after cleanup without storing raw native errors',()=>{
  const {db,service,call}=fixture();
  service.recordFailure(call.voice_id,'VOICE_CONFIG');service.state(call.voice_id,'closed');service.recordFailure(call.voice_id,'VOICE_NATIVE_ERROR');
  assert.equal(JSON.parse(service.get(call.voice_id)!.binding_json).failureCode,'VOICE_CONFIG');
  assert.equal(service.recordFailure('missing','Bearer private-token'),'VOICE_NATIVE_ERROR');db.close();
});

test('task status failures preserve the call and dispatch; status recovers without resending work',t=>{
 const f=fixture();t.after(()=>f.db.close());f.dispatch();
 const describe=f.service.describe.bind(f.service);
 f.service.describe=()=>{throw Error('temporary projection failure');};
 assert.equal(f.service.poll(f.principal,f.call.voice_id).unavailable,true);
 assert.equal(f.service.get(f.call.voice_id)?.state,'active');
 f.service.describe=describe;
 assert.equal(f.service.poll(f.principal,f.call.voice_id).task?.state,'submitted');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,1);
});

for (const previouslyReported of [false,true]) test(`reconnecting never automatically speaks an old completed task (reported=${previouslyReported})`,t=>{
 const f=fixture();t.after(()=>f.db.close());const job=f.dispatch() as {jobId:string};
 f.db.run("UPDATE panel_voice_jobs SET state='completed' WHERE job_id=?",job.jobId);
 assert.equal(f.service.poll(f.principal,f.call.voice_id).report?.reportId,job.jobId);
 if(previouslyReported) f.service.acknowledgeReport(f.call.voice_id,job.jobId);
 f.service.state(f.call.voice_id,'closed');
 const next=f.service.start(f.principal,'m',{});f.service.state(next.voice_id,'active');
 assert.equal(f.service.poll(f.principal,next.voice_id).report,null);
 assert.equal(f.service.report(f.principal,next.voice_id),null);
 assert.equal((f.service.tool(f.principal,next.voice_id,'ask-status',{action:'status',sessionId:f.session.logicalSessionId}) as {jobId:string}).jobId,job.jobId,'explicit session status remains available');
 f.service.acknowledgeReport(next.voice_id,job.jobId);
 assert.equal(f.db.get<{reported_call_id:string|null}>("SELECT reported_call_id FROM panel_voice_jobs WHERE job_id=?",job.jobId)?.reported_call_id,previouslyReported?f.call.voice_id:null,'new calls cannot steal report acknowledgements');
});
test('a previous-call task finishing during a new call remains silent',t=>{
 const f=fixture();t.after(()=>f.db.close());const job=f.dispatch() as {jobId:string};
 f.service.state(f.call.voice_id,'closed');const next=f.service.start(f.principal,'m',{});f.service.state(next.voice_id,'active');
 assert.equal(f.service.poll(f.principal,next.voice_id).report,null);
 f.db.run("UPDATE panel_voice_jobs SET state='completed' WHERE job_id=?",job.jobId);
 assert.equal(f.service.poll(f.principal,next.voice_id).task,null);
 assert.equal(f.service.poll(f.principal,next.voice_id).report,null);
});

test('status is session-scoped, authorized, and never falls back to another session or call',t=>{
 const f=fixture();t.after(()=>f.db.close());const first=f.dispatch() as {jobId:string};
 const other=f.registry.createSession(f.principal,'m','p','Other session','other-session');
 const query=(input:Record<string,unknown>)=>f.service.tool(f.principal,f.call.voice_id,'status',{action:'status',...input}) as Record<string,unknown>;
 assert.equal(query({sessionId:other.logicalSessionId}).state,'idle');
 assert.equal(query({sessionId:other.logicalSessionId}).hasCoordinatorJob,false);
 assert.equal(query({sessionId:other.logicalSessionId}).jobId,undefined);
 assert.equal(query({sessionId:f.session.logicalSessionId}).jobId,first.jobId);
 assert.equal(query({}).jobId,first.jobId);
 for(const sessionId of ['',null,42,'forbidden']) assert.throws(()=>query({sessionId}));
 f.db.run("UPDATE panel_voice_jobs SET state='completed'");
 assert.equal(query({sessionId:other.logicalSessionId}).state,'idle');
 f.service.state(f.call.voice_id,'closed');const next=f.service.start(f.principal,'m',{});f.service.state(next.voice_id,'active');
 assert.equal((f.service.tool(f.principal,next.voice_id,'status',{action:'status'}) as {state:string}).state,'idle');
 assert.equal((f.service.tool(f.principal,next.voice_id,'status',{action:'status',sessionId:f.session.logicalSessionId}) as {jobId:string}).jobId,first.jobId);
 assert.equal(f.service.poll(f.principal,next.voice_id).task,null);
 const previous=f.service.current(f.principal)!;
 f.db.run("INSERT INTO panel_voice_jobs VALUES('other-job',?,?,?,?,?,?,NULL,'completed',NULL,?)",f.principal.userId,f.principal.workspaceId,next.voice_id,'other-request',other.logicalSessionId,previous.command_id,new Date().toISOString());
 assert.equal((f.service.tool(f.principal,next.voice_id,'status',{action:'status',sessionId:f.session.logicalSessionId}) as {jobId:string}).jobId,first.jobId);
 assert.equal((f.service.tool(f.principal,next.voice_id,'status',{action:'status',sessionId:other.logicalSessionId}) as {jobId:string}).jobId,'other-job');
});

test('maintenance gates dispatch and search without blocking cancellation, and clears on recovery',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE machines SET command_types_json=?",JSON.stringify(['turn.start','turn.cancel','turn.queue','turn.steer']));
 f.db.run("UPDATE machines SET maintenance_json=?",JSON.stringify({operationId:'update-test',startedAt:new Date().toISOString()}));
 const session=f.registry.getSession(f.principal,f.session.logicalSessionId);
 assert.equal(session.actions.start.reasonCode,'MACHINE_DRAINING');
 assert.equal(session.actions.queue.reasonCode,'MACHINE_DRAINING');
 assert.throws(()=>f.dispatch(),/主机正在维护/);
 assert.throws(()=>f.coordination.createCommand(f.principal,f.session.logicalSessionId,{type:'turn.start',clientMutationId:'maintenance-direct',payload:{prompt:'Test only'},precondition:{}}),/主机正在维护/);
 const found=f.service.tool(f.principal,f.call.voice_id,'search',{action:'search',query:'Test'}) as {sessions:{available:boolean;unavailableReason:{code:string}}[]};
 assert.equal(found.sessions[0]?.available,false);assert.equal(found.sessions[0]?.unavailableReason.code,'MACHINE_DRAINING');
 f.db.run("UPDATE logical_sessions SET active_turn_id='turn-active',execution_state='running'");
 assert.equal(f.registry.getSession(f.principal,f.session.logicalSessionId).actions.cancel.allowed,true);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
 f.service.state(f.call.voice_id,'closed');assert.throws(()=>f.service.start(f.principal,'m',{}),/维护/);
 f.db.run("UPDATE logical_sessions SET active_turn_id=NULL,execution_state='idle'");
 f.db.run("UPDATE machines SET maintenance_json='null'");
 assert.equal(f.registry.getSession(f.principal,f.session.logicalSessionId).actions.start.allowed,true);
});

test('host rejection exposes its exact cause and does not claim missing history; unknown is not unstarted',t=>{
 const f=fixture();t.after(()=>f.db.close());f.dispatch();const job=f.service.current(f.principal)!;
 f.db.run("UPDATE command_projection SET state='invalidated'");
 f.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)",job.command_id,JSON.stringify({code:'MACHINE_DRAINING',message:'the agent is waiting for a safe maintenance restart'}),new Date().toISOString());
 const result=f.service.describe(f.principal,f.service.current(f.principal)!);
 assert.equal(result.state,'failed');assert.equal(result.executionStarted,false);
 assert.equal(result.error?.code,'MACHINE_DRAINING');assert.equal(result.error?.message,'the agent is waiting for a safe maintenance restart');
 assert.equal(result.historyLimited,false);assert.equal(result.result,'');assert.equal(result.resultStatus,'not_started');
 f.db.run("UPDATE panel_voice_jobs SET state='unknown'");f.db.run("UPDATE command_projection SET state='unknown'");
 f.db.run("DELETE FROM command_lifecycle WHERE state='invalidated'");
 const unknown=f.service.describe(f.principal,f.service.current(f.principal)!);
 assert.equal(unknown.executionStarted,null);assert.equal(unknown.historyLimited,false);
 assert.throws(()=>f.dispatch('retry'),/已有任务/);
});

function otherProject(f:ReturnType<typeof fixture>, id:string, machine='m') {
 const at=new Date().toISOString();
 f.db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES(?,?,?,?,?,?,?,?,?)",id,f.principal.workspaceId,machine,id,`Project ${id}`,`/fixture/${id}`,`hash-${id}`,at,at);
 return f.registry.createSession(f.principal,machine,id,`Session ${id}`,`fixture-${id}`);
}
test('distinct projects run concurrently; same project, uncertain outcomes and changed retry targets remain fenced',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const first=f.dispatch() as {jobId:string};
 const second=otherProject(f,'other');
 f.db.run("UPDATE command_projection SET state='unknown'");
 const next=f.service.tool(f.principal,f.call.voice_id,'request-other',{action:'dispatch',sessionId:second.logicalSessionId,prompt:'Check other project'}) as {jobId:string;projectId:string};
 assert.notEqual(next.jobId,first.jobId);assert.equal(next.projectId,'other');
 const sameProject=f.registry.createSession(f.principal,'m','p','Another session','fixture-same-project');
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'same-project',{action:'dispatch',sessionId:sameProject.logicalSessionId,prompt:'Check'}),/该项目已有任务/);
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'request-one',{action:'dispatch',sessionId:second.logicalSessionId,prompt:'Read project status'}),/请求标识/);
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'request-one',{action:'dispatch',sessionId:f.session.logicalSessionId,prompt:'Changed instruction'}),/请求标识/);
 assert.equal((f.dispatch() as {jobId:string}).jobId,first.jobId);
 const all=f.service.tool(f.principal,f.call.voice_id,'status',{action:'status'}) as {tasks:{jobId:string}[];activeCount:number};
 assert.equal(all.activeCount,2);assert.deepEqual(new Set(all.tasks.map(j=>j.jobId)),new Set([first.jobId,next.jobId]));
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'status',{action:'status',jobId:first.jobId,sessionId:second.logicalSessionId}),/没有此任务/);
 const exact=f.service.tool(f.principal,f.call.voice_id,'status',{action:'status',jobId:next.jobId}) as {jobId:string;sessionId:string};
 assert.equal(exact.jobId,next.jobId);assert.equal(exact.sessionId,second.logicalSessionId);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,2);
 f.service.state(f.call.voice_id,'closed');const call=f.service.start(f.principal,'m',{});f.service.state(call.voice_id,'active');
 assert.equal(f.service.poll(f.principal,call.voice_id).tasks.length,0);
 assert.throws(()=>f.service.tool(f.principal,call.voice_id,'new-call',{action:'dispatch',sessionId:second.logicalSessionId,prompt:'Duplicate'}),/该项目已有任务/);
});
test('parallel results and progress remain turn-scoped; reports are independent of unfinished work and not lost after 20 jobs',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const a=f.dispatch() as {jobId:string};const second=otherProject(f,'other');
 const b=f.service.tool(f.principal,f.call.voice_id,'request-other',{action:'dispatch',sessionId:second.logicalSessionId,prompt:'Check other'}) as {jobId:string};
 f.db.run("UPDATE panel_voice_jobs SET native_turn_id='turn-a',state='running' WHERE job_id=?",a.jobId);
 f.db.run("UPDATE panel_voice_jobs SET native_turn_id='turn-b',state='completed' WHERE job_id=?",b.jobId);
 // Many newer completed jobs must not evict outstanding work or unreported results.
 for(let i=0;i<25;i++) f.db.run("INSERT INTO panel_voice_jobs SELECT ?,user_id,workspace_id,voice_id,?,session_id,command_id,NULL,'completed',voice_id,'9999-01-01' FROM panel_voice_jobs WHERE job_id=?",`history-${i}`,`history-request-${i}`,b.jobId);
 const poll=f.service.poll(f.principal,f.call.voice_id);
 assert.ok(poll.tasks.some(j=>j.jobId===a.jobId&&j.progress.nativeTurnId==='turn-a'));
 assert.equal(poll.report?.reportId,b.jobId);assert.equal(poll.report?.result.progress.nativeTurnId,'turn-b');
 f.service.acknowledgeReport('wrong-call',b.jobId);assert.equal(f.service.report(f.principal,f.call.voice_id)?.reportId,b.jobId);
 f.service.acknowledgeReport(f.call.voice_id,b.jobId);assert.equal(f.service.report(f.principal,f.call.voice_id),null);
 assert.throws(()=>f.dispatch('repeat-old-active'),/该项目已有任务/);
 f.db.run("UPDATE panel_voice_jobs SET state='interrupted' WHERE job_id=?",a.jobId);
 assert.equal(f.service.report(f.principal,f.call.voice_id)?.reportId,a.jobId);
 f.service.acknowledgeReport(f.call.voice_id,a.jobId);assert.equal(f.service.report(f.principal,f.call.voice_id),null);
});

test('schema 49 migration preserves work and enables another host project after reopening',t=>{
 const f=fixture();t.after(()=>f.db.close());const original=f.dispatch() as {jobId:string};
 const dir=mkdtempSync(join(tmpdir(),'panel-parallel-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');
 f.db.sqlite.exec(`VACUUM INTO '${path.replaceAll("'","''")}'`);
 let db=new ControlPlaneDatabase(path);
 db.sqlite.exec("DROP INDEX panel_voice_one_session_job; CREATE UNIQUE INDEX panel_voice_one_job ON panel_voice_jobs(user_id) WHERE state IN ('submitted','running','unknown'); PRAGMA user_version=49");db.close();
 db=new ControlPlaneDatabase(path);t.after(()=>db.close());
 assert.equal(db.get<{user_version:number}>('PRAGMA user_version')?.user_version,54);
 assert.equal(db.get<{job_id:string}>('SELECT job_id FROM panel_voice_jobs')?.job_id,original.jobId);
 const config=loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'panel@example.test',ADMIN_PASSWORD:'panel-test-password',PUBLIC_ORIGIN:'http://panel.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'});
 const registry=new RegistryService(db,config);const service=new PanelVoiceService(db,registry,new CoordinationService(db,config));
 db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at)
 SELECT 'm2',workspace_id,'key2','fingerprint2','Second host',platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at FROM machines WHERE machine_id='m'`);
 const second=otherProject({...f,db,registry},'remote','m2');
 const result=service.tool(f.principal,f.call.voice_id,'remote-job',{action:'dispatch',sessionId:second.logicalSessionId,prompt:'Check remote project'}) as {machineId:string;jobId:string};
 assert.equal(result.machineId,'m2');assert.notEqual(result.jobId,original.jobId);
 assert.equal(service.poll(f.principal,f.call.voice_id).tasks.length,2);
 assert.equal(db.all('PRAGMA foreign_key_check').length,0);
});

test('pending voice intent survives hangup and recovery; dispatch requires confirmation and is unique across calls',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const save=()=>f.service.tool(f.principal,f.call.voice_id,'save-retry',{action:'todo.save',intent:'Develop the requested feature later',sessionId:f.session.logicalSessionId}) as {todoId:string;revision:number};
 const todo=save();assert.equal(save().todoId,todo.todoId);assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);
 f.service.closeOrphans();const restarted=new PanelVoiceService(f.db,f.registry,f.coordination);
 const call=restarted.start(f.principal,'m',{});
 const before=f.db.get<{n:number}>('SELECT count(*) n FROM commands')!.n;
 const restored=restarted.tool(f.principal,call.voice_id,'startup-read',{action:'recover'}) as {items:{todoId:string;state:string}[]};
 assert.equal(restored.items[0]!.todoId,todo.todoId);assert.equal(restored.items[0]!.state,'pending');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,before);
 assert.throws(()=>restarted.tool(f.principal,call.voice_id,'bad-start',{action:'dispatch',todoId:todo.todoId,revision:todo.revision,confirmed:true}),/总控通话/);
 restarted.state(call.voice_id,'active');
 assert.equal((restarted.tool(f.principal,call.voice_id,'todo-status',{action:'status',todoId:todo.todoId}) as {todoId:string}).todoId,todo.todoId);
 assert.throws(()=>restarted.tool(f.principal,call.voice_id,'no-consent',{action:'dispatch',todoId:todo.todoId,revision:todo.revision}),/明确确认/);
 const sent=restarted.tool(f.principal,call.voice_id,'confirmed',{action:'dispatch',todoId:todo.todoId,revision:todo.revision,confirmed:true}) as {jobId:string;todoId:string};
 assert.equal(sent.todoId,todo.todoId);restarted.state(call.voice_id,'closed');
 const third=restarted.start(f.principal,'m',{});restarted.state(third.voice_id,'active');
 const retry=restarted.tool(f.principal,third.voice_id,'different-request',{action:'dispatch',todoId:todo.todoId}) as {jobId:string;duplicate:boolean};
 assert.equal(retry.jobId,sent.jobId);assert.equal(retry.duplicate,true);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,1);
 assert.equal(restarted.poll(f.principal,third.voice_id).report,null);
 assert.throws(()=>restarted.memory.get({...f.principal,userId:'someone-else'},todo.todoId),/没有此/);
 assert.equal(restarted.recover({...f.principal,userId:'someone-else'}).total,0);
});

test('pending todo edits use revisions, cancellations cannot dispatch, and failed command insertion leaves a recoverable todo',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const todo=f.service.memory.save(f.principal,{intent:'Draft a feature',key:'stable-key'});
 assert.throws(()=>f.service.memory.save(f.principal,{intent:'Different feature',key:'stable-key'}),/不同内容/);
 const updated=f.service.memory.update(f.principal,todo.todo_id,{revision:1,intent:'Draft clarified feature',sessionId:f.session.logicalSessionId});
 assert.throws(()=>f.service.memory.update(f.principal,todo.todo_id,{revision:1,state:'cancelled'}),/已变化/);
 f.db.sqlite.exec("CREATE TRIGGER reject_memory_job BEFORE INSERT ON panel_voice_jobs BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'dispatch',{action:'dispatch',todoId:todo.todo_id,revision:updated.revision,confirmed:true}),/test failure/);
 assert.equal(f.service.memory.get(f.principal,todo.todo_id).state,'pending');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM panel_voice_task_records')?.n,0);
 f.service.memory.update(f.principal,todo.todo_id,{revision:updated.revision,state:'cancelled'});
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'dispatch-again',{action:'dispatch',todoId:todo.todo_id,revision:3,confirmed:true}),/取消/);
 assert.equal(f.service.recover(f.principal).total,0);assert.equal(f.service.recover(f.principal,{view:'all'}).total,1);
});

test('results persist after call closure; recovery does not acknowledge, speak or dispatch; deleted output never resurrects',t=>{
 const f=fixture();t.after(()=>f.db.close());const task=f.dispatch() as {jobId:string;todoId:string};
 const job=f.service.current(f.principal)!;f.service.closeOrphans();
 const at=new Date().toISOString();
 for(const [seq,type,body] of [[1,'turn.started',{commandId:job.command_id}],[2,'item.completed',{item:{type:'agentMessage',text:'Verified task result'}}],[3,'turn.completed',{turn:{status:'completed'}}]] as const){
  f.db.run('INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)',`memory-${seq}`,f.principal.workspaceId,JSON.stringify(body),'hash',at,'9999-12-31T00:00:00Z');
  f.db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state)
   VALUES(?,'hash','agent',?,?,?,'m','p',?,1,'thread','memory-turn',?,'1',?,?,?,'present')`,`memory-event-${seq}`,f.principal.workspaceId,f.session.logicalSessionId,f.session.executionSegmentId,seq,type,at,at,`memory-${seq}`);
 }
 f.service.syncMemory();
 assert.match(f.db.get<{result_json:string}>('SELECT result_json FROM panel_voice_task_records WHERE job_id=?',task.jobId)!.result_json,/Verified task result/);
 const call=f.service.start(f.principal,'m',{});f.service.state(call.voice_id,'active');
 const recovered=f.service.recover(f.principal).items[0]!;assert.equal(recovered.job!.result,'Verified task result');assert.equal(recovered.job!.acknowledgedAt,null);
 assert.equal(f.service.report(f.principal,call.voice_id),null);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,1);
 assert.throws(()=>f.service.tool(f.principal,call.voice_id,'ack',{action:'acknowledge',todoId:task.todoId}),/用户确认/);
 f.service.tool(f.principal,call.voice_id,'ack',{action:'acknowledge',todoId:task.todoId,confirmed:true});assert.equal(f.service.recover(f.principal).total,0);
 assert.equal(f.service.recover(f.principal,{view:'all'}).items[0]!.job!.result,'Verified task result');
 f.db.run("UPDATE content_blobs SET deleted_at=? WHERE payload_ref='memory-2'",at);
 assert.equal(f.service.recover(f.principal,{view:'all'}).items[0]!.job!.result,'');
 assert.doesNotMatch(f.db.get<{result_json:string}>('SELECT result_json FROM panel_voice_task_records WHERE job_id=?',task.jobId)!.result_json,/Verified task result/);
});

test('schema 50 backfills existing jobs without execution and recovery paginates unbound pending intents',t=>{
 const f=fixture();t.after(()=>f.db.close());const old=f.dispatch() as {jobId:string};
 const dir=mkdtempSync(join(tmpdir(),'voice-memory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');
 f.db.sqlite.exec(`VACUUM INTO '${path.replaceAll("'","''")}'`);
 let db=new ControlPlaneDatabase(path);db.sqlite.exec('DROP TABLE panel_voice_todo_resolutions; DROP TABLE panel_voice_task_records; DROP TABLE panel_voice_todos; PRAGMA user_version=50');db.close();
 db=new ControlPlaneDatabase(path);t.after(()=>db.close());
 assert.equal(db.get<{user_version:number}>('PRAGMA user_version')?.user_version,54);
 assert.equal(db.get<{job_id:string}>('SELECT job_id FROM panel_voice_task_records')?.job_id,old.jobId);
 assert.equal(db.get<{original_intent:string}>('SELECT original_intent FROM panel_voice_task_records')?.original_intent,'Read project status');
 const config=loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'panel@example.test',ADMIN_PASSWORD:'panel-test-password',PUBLIC_ORIGIN:'http://panel.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'});
 const registry=new RegistryService(db,config),service=new PanelVoiceService(db,registry,new CoordinationService(db,config));
 for(let i=0;i<25;i++)service.memory.save(f.principal,{intent:`Deferred task ${i}`,key:`intent-${i}`});
 const first=service.recover(f.principal);assert.equal(first.items.length,20);assert.equal(first.total,26);
 const second=service.recover(f.principal,{cursor:first.nextCursor});assert.equal(second.items.length,6);
 assert.equal(new Set([...first.items,...second.items].map(item=>item.todoId)).size,26);
 assert.equal(db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,1);
 assert.equal(db.all('PRAGMA foreign_key_check').length,0);
});

test('cancelled intent from an unsuccessful legacy dispatch cannot be resurrected by retrying the original request',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE machines SET maintenance_json=? WHERE machine_id='m'",JSON.stringify({operationId:'safe-update',startedAt:new Date().toISOString()}));
 assert.throws(()=>f.dispatch());
 const todo=f.service.recover(f.principal).items[0]!;assert.equal(todo.state,'pending');
 f.service.memory.update(f.principal,todo.todoId,{revision:todo.revision,state:'cancelled'});
 f.db.run("UPDATE machines SET maintenance_json=NULL WHERE machine_id='m'");
 assert.throws(()=>f.dispatch(),/取消/);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);
});

test('voice steering appends to the exact running turn, deduplicates across calls, and never creates a second job',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const job=f.dispatch() as {jobId:string};
 f.db.run("UPDATE machines SET command_types_json='[\"turn.start\",\"turn.steer\"]'");
 f.db.run("UPDATE logical_sessions SET active_turn_id='live-turn',execution_state='running' WHERE logical_session_id=?",f.session.logicalSessionId);
 f.db.run("UPDATE panel_voice_jobs SET native_turn_id='live-turn',state='running' WHERE job_id=?",job.jobId);
 const args={action:'steer',sessionId:f.session.logicalSessionId,jobId:job.jobId,nativeTurnId:'live-turn',prompt:'Also check the tests',idempotencyKey:'explicit-addition-one'};
 const first=f.service.tool(f.principal,f.call.voice_id,'steer-one',args) as {commandId:string;sessionId:string};
 assert.equal(first.sessionId,f.session.logicalSessionId);
 assert.equal(f.db.get<{type:string}>('SELECT type FROM commands WHERE command_id=?',first.commandId)?.type,'turn.steer');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM panel_voice_jobs')?.n,1);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,2);
 f.service.closeOrphans();const next=f.service.start(f.principal,'m',{});f.service.state(next.voice_id,'active');
 f.db.run("UPDATE logical_sessions SET active_turn_id=NULL,execution_state='idle'");
 const retry=f.service.tool(f.principal,next.voice_id,'steer-two',args) as {commandId:string;duplicate:boolean};
 assert.equal(retry.commandId,first.commandId);assert.equal(retry.duplicate,true);
 assert.throws(()=>f.service.tool(f.principal,next.voice_id,'changed',{...args,prompt:'Different instruction'}),/追加标识/);
 assert.throws(()=>f.service.tool(f.principal,next.voice_id,'late',{...args,idempotencyKey:'new-key'}),/已结束/);
 const status=f.service.tool(f.principal,next.voice_id,'read',{action:'status',commandId:first.commandId,sessionId:first.sessionId}) as {commandId:string};
 assert.equal(status.commandId,first.commandId);
 assert.throws(()=>f.service.tool(f.principal,next.voice_id,'wrong',{action:'status',commandId:first.commandId,sessionId:'other-session'}),/没有此/);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,2);
});

test('voice steering respects host maintenance, target turn, capability and user ownership',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE logical_sessions SET active_turn_id='live-turn',execution_state='running'");
 const args={action:'steer',sessionId:f.session.logicalSessionId,nativeTurnId:'live-turn',prompt:'Check tests',idempotencyKey:'one'};
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'unsupported',args));
 f.db.run("UPDATE machines SET command_types_json='[\"turn.start\",\"turn.steer\"]',maintenance_json=?",JSON.stringify({operationId:'maintenance',startedAt:new Date().toISOString()}));
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'draining',args),/维护/);
 f.db.run("UPDATE machines SET maintenance_json='null'");
 assert.throws(()=>f.service.tool(f.principal,f.call.voice_id,'wrong-turn',{...args,nativeTurnId:'old-turn'}),/发生变化/);
 const created=f.service.tool(f.principal,f.call.voice_id,'ok',args) as {commandId:string};
 assert.throws(()=>f.service['describeSteer']({...f.principal,userId:'someone-else'},created.commandId),/没有此/);
});

test('text-panel user can supplement a voice-dispatched turn from another browser of the same account',t=>{
 const f=fixture();t.after(()=>f.db.close());f.dispatch();
 const browser=f.auth.servicePrincipal('text-browser');
 f.db.run("UPDATE machines SET command_types_json='[\"turn.start\",\"turn.steer\"]'");
 f.db.run("UPDATE logical_sessions SET active_turn_id='voice-started-turn',execution_state='running'");
 const session=f.registry.getSession(browser,f.session.logicalSessionId);
 assert.equal(session.actions.steer.allowed,true);assert.equal(session.controlLease?.isMine,true);
 const response=f.coordination.createCommand(browser,session.logicalSessionId,{type:'turn.steer',clientMutationId:'manual-append',payload:{prompt:'Additional requirement from the text panel'},precondition:{nativeTurnId:session.activeTurnId!,turnControlVersion:session.turnControlVersion}},true);
 assert.equal(response.command.type,'turn.steer');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM panel_voice_jobs')?.n,1);
 assert.equal(f.db.get<{n:number}>("SELECT count(*) n FROM commands WHERE type='turn.start'")?.n,1);
});

test('panel deployment fences new calls while active voice tools, task reports and natural hangup keep working',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const job=f.dispatch() as {jobId:string};
 f.db.run("INSERT INTO voice_deployment_guard VALUES(1,'publisher','next-image',?)",new Date().toISOString());
 assert.throws(()=>f.service.start(f.principal,'m',{}),/等待安全更新/);
 const status=f.service.tool(f.principal,f.call.voice_id,'status-during-deploy',{action:'status',jobId:job.jobId}) as {jobId:string};
 assert.equal(status.jobId,job.jobId);assert.equal(f.service.get(f.call.voice_id)?.state,'active');
 assert.equal(f.service.poll(f.principal,f.call.voice_id).unavailable,false);
 f.service.state(f.call.voice_id,'closed');
 assert.throws(()=>f.service.start(f.principal,'m',{}),/等待安全更新/);
 f.db.run('DELETE FROM voice_deployment_guard');
 assert.equal(f.service.start(f.principal,'m',{}).state,'starting');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,1);
});

function continuationFixture() {
 const f=fixture(),task=f.dispatch() as {jobId:string;todoId:string};
 f.db.run("UPDATE panel_voice_jobs SET state='failed',native_turn_id='original' WHERE job_id=?",task.jobId);
 const at=new Date().toISOString();
 const add=(seq:number,type:string,body:unknown,session=f.session.logicalSessionId)=>{
  f.db.run('INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)',`continuation-${seq}`,f.principal.workspaceId,JSON.stringify(body),'hash',at,'9999-12-31T00:00:00Z');
  f.db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state)
   VALUES(?,'hash','agent',?,?,?,'m','p',?,1,'thread','continued',?,'1',?,?,?,'present')`,`continuation-event-${seq}`,f.principal.workspaceId,session,f.session.executionSegmentId,seq,type,at,at,`continuation-${seq}`);
 };
 add(1,'item.completed',{item:{type:'agentMessage',phase:'final_answer',text:'The requested feature is shipped.'}});
 add(2,'turn.completed',{turn:{id:'continued',status:'completed'}});
 const input={action:'todo.update',todoId:task.todoId,revision:2,sessionId:f.session.logicalSessionId,nativeTurnId:'continued',confirmed:true};
 return {...f,task,input,add};
}
test('manual continuation resolves intent, preserves failed job, audits once and never dispatches on retry or recovery',t=>{
 const f=continuationFixture();t.after(()=>f.db.close());
 const update=()=>f.service.tool(f.principal,f.call.voice_id,'resolve',f.input) as {state:string;resolution:{result:string};job:{state:string}};
 const result=update();assert.equal(result.state,'completed');assert.equal(result.job.state,'failed');
 assert.equal(result.resolution.result,'The requested feature is shipped.');
 assert.equal(f.service.recover(f.principal).total,0);
 assert.equal(f.service.recover(f.principal,{view:'all'}).items[0]!.state,'completed');
 assert.equal(update().state,'completed');
 assert.equal(f.db.get<{n:number}>("SELECT count(*) n FROM audit_entries WHERE action='voice.todo.manual_completion'")!.n,1);
 const status=f.service.tool(f.principal,f.call.voice_id,'status',{action:'status',todoId:f.task.todoId}) as {state:string;job:{state:string}};
 assert.equal(status.state,'completed');assert.equal(status.job.state,'failed');
 const exact=f.service.tool(f.principal,f.call.voice_id,'status',{action:'status',jobId:f.task.jobId}) as {state:string;todoState:string};
 assert.equal(exact.state,'failed');assert.equal(exact.todoState,'completed');
 const retried=f.service.tool(f.principal,f.call.voice_id,'retry',{action:'dispatch',todoId:f.task.todoId,sessionId:f.session.logicalSessionId,confirmed:true}) as {jobId:string};
 assert.equal(retried.jobId,f.task.jobId);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')!.n,1);
 assert.equal(f.db.all('PRAGMA foreign_key_check').length,0);
});
test('manual completion rejects missing consent, wrong owner/session/turn, stale revision and unfinished jobs',t=>{
 const f=continuationFixture();t.after(()=>f.db.close());
 const update=(extra:Record<string,unknown>)=>f.service.memory.update(f.principal,f.task.todoId,{...f.input,...extra});
 assert.throws(()=>update({confirmed:false}),/明确确认/);
 assert.throws(()=>update({sessionId:'different'}),/原会话/);
 assert.throws(()=>update({jobId:'different'}),/任务标识/);
 assert.throws(()=>update({revision:1}),/已变化/);
 assert.throws(()=>update({nativeTurnId:'original'}),/独立/);
 assert.throws(()=>update({nativeTurnId:'missing'}),/完成证据/);
 assert.throws(()=>f.service.memory.update({...f.principal,userId:'other'},f.task.todoId,f.input),/没有此语音待办/);
 f.db.run("UPDATE panel_voice_jobs SET state='unknown'");
 assert.throws(()=>update({}),/尚未确定结束/);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM panel_voice_todo_resolutions')!.n,0);
});
test('completion evidence must be current, final, native and accessible; expiry removes content but not resolution',t=>{
 const f=continuationFixture();t.after(()=>f.db.close());
 const update=()=>f.service.memory.update(f.principal,f.task.todoId,f.input);
 f.db.run("UPDATE projects SET sync_content=0");assert.throws(update,/未授权/);f.db.run("UPDATE projects SET sync_content=1");
 f.db.run("UPDATE durable_events SET source_kind='control_plane' WHERE event_id='continuation-event-2'");
 assert.throws(update,/完成证据/);f.db.run("UPDATE durable_events SET source_kind='agent'");
 f.db.run("UPDATE content_blobs SET expires_at='2000-01-01' WHERE payload_ref='continuation-1'");
 assert.throws(update,/最终回复/);f.db.run("UPDATE content_blobs SET expires_at='9999-12-31T00:00:00Z'");
 update();
 f.db.run("UPDATE content_blobs SET deleted_at=? WHERE payload_ref='continuation-1'",new Date().toISOString());
 const record=f.service.recover(f.principal,{view:'all'}).items[0]!;
 assert.equal(record.state,'completed');assert.equal(record.resolution!.result,'');assert.equal(record.resolution!.historyLimited,true);
 assert.equal(f.service.recover(f.principal).total,0);
 assert.throws(()=>f.service.memory.update(f.principal,f.task.todoId,{...f.input,nativeTurnId:'different'}),/不能覆盖/);
});
