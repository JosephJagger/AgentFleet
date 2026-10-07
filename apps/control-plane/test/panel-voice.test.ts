import test from 'node:test';
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
