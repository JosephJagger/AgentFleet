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
  f.service.acknowledgeReport(f.call.voice_id,report.reportId);
  assert.equal(f.service.report(f.principal,f.call.voice_id),null);
  f.db.run("UPDATE content_blobs SET deleted_at='now' WHERE payload_ref='payload-3'");
  assert.equal(f.service.describe(f.principal,f.service.current(f.principal)!).result,'');
  f.db.run("UPDATE content_blobs SET body_json='{}' WHERE payload_ref='payload-4'");
  assert.equal(f.service.current(f.principal)?.state,'completed','confirmed terminal state survives content expiration');
});
