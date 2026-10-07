import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {PanelVoiceService} from '../src/panel-voice.js';
import {SessionProgressService} from '../src/session-progress.js';
function fixture(){
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'progress@example.test',ADMIN_PASSWORD:'fixture-password',PUBLIC_ORIGIN:'http://fixture.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const db=new ControlPlaneDatabase(':memory:');const {workspaceId}=db.bootstrap(config);const auth=new AuthService(db,config);const principal=auth.servicePrincipal('progress-fixture');
 let now=Date.now();const at=new Date(now).toISOString();
 db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Host','linux','24','x64','0.30.85','online','compatible','["turn.start"]',?,?,?)`,workspaceId,at,at,at);
 db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','p','Demo','/fixture','hash',?,?)",workspaceId,at,at);
 const registry=new RegistryService(db,config);const session=registry.createSession(principal,'m','p','Progress fixture','progress-session');
 const progress=new SessionProgressService(db,registry,()=>now);let seq=0;
 const event=(type:string,item:unknown,turn='turn-current')=>{
  const n=++seq,ref=`blob-${n}`;
  db.run("INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)",ref,workspaceId,JSON.stringify(item),'hash',at,'9999-12-31T00:00:00Z');
  const id=(item as {item?:{id?:string}}).item?.id??null;
  db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,native_item_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state) VALUES(?,'hash','agent',?,?,?,'m','p',?,1,'native',?,?,?,'1',?,?,?,'present')`,`event-${n}`,workspaceId,session.logicalSessionId,session.executionSegmentId,n,turn,id,type,at,at,ref);
  return ref;
 };
 const running=()=>db.run("UPDATE logical_sessions SET execution_state='running',active_turn_id='turn-current' WHERE logical_session_id=?",session.logicalSessionId);
 const read=()=>progress.read(principal,session.logicalSessionId);
 const stream=(id:string,value:string,turn='turn-current')=>progress.record(session.logicalSessionId,session.executionSegmentId,turn,id,'command_output.delta',value,false);
 return {db,registry,principal,session,progress,event,running,read,stream,config,advance:(ms:number)=>{now+=ms;}};
}
test('native item starts and partial command output are available before turn completion, bounded and scoped',t=>{
 const f=fixture();t.after(()=>f.db.close());f.running();
 f.event('item.completed',{item:{id:'old',type:'agentMessage',text:'Other turn result'}},'old-turn');
 f.event('item.started',{item:{id:'cmd',type:'commandExecution',command:'npm test',status:'inProgress'}});
 f.event('item.started',{item:{id:'patch',type:'fileChange',status:'inProgress',changes:[{path:'src/example.ts',diff:'+ corrected'}]}});
 f.event('item.started',{item:{id:'thought',type:'reasoning',summary:['private reasoning']}});
 f.stream('cmd','First test passed\n');f.stream('cmd','Second test running');
 const value=f.read();assert.equal(value.state,'running');assert.equal(value.freshness,'live');
 assert.equal(value.items.find(i=>i.id==='cmd')?.output,'First test passed\nSecond test running');
 assert.equal(value.items.find(i=>i.id==='patch')?.title,'src/example.ts');assert.equal(value.items.some(i=>i.id==='old'||i.id==='thought'),false);
 assert.equal(f.db.get<{n:number}>("SELECT count(*) AS n FROM durable_events WHERE type='turn.completed'")?.n,0);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
 f.stream('cmd','x'.repeat(10000));assert.equal(f.read().items.find(i=>i.id==='cmd')?.output?.length,4000);assert.equal(f.read().limited,true);
 f.event('item.completed',{item:{id:'cmd',type:'commandExecution',command:'npm test',status:'completed',aggregatedOutput:'All tests passed'}});
 assert.equal(f.read().items.find(i=>i.id==='cmd')?.output,'All tests passed');assert.equal(f.read().items.find(i=>i.id==='cmd')?.status,'completed');
});
test('progress enforces authorization, content policy, deletion, epochs, stale status and volatile expiry',t=>{
 const f=fixture();t.after(()=>f.db.close());f.running();
 assert.throws(()=>f.progress.read({...f.principal,workspaceId:'other'},f.session.logicalSessionId));
 f.stream('cmd','live output');f.stream('foreign','wrong turn','foreign-turn');
 assert.equal(f.read().items.length,1);
 f.db.run("UPDATE logical_sessions SET content_epoch=content_epoch+1");assert.equal(f.read().items.length,0);
 f.stream('cmd','new output');const blob=f.event('item.started',{item:{id:'cmd',type:'commandExecution',command:'test'}});
 f.db.run("UPDATE content_blobs SET deleted_at=? WHERE payload_ref=?",new Date().toISOString(),blob);
 assert.equal(f.read().items.length,0);
 f.stream('other','secret');f.db.run('UPDATE projects SET sync_content=0');assert.equal(f.read().contentAvailable,false);assert.equal(f.read().items.length,0);
 f.db.run('UPDATE projects SET sync_content=1');assert.equal(f.read().items.length,0);
 f.stream('another','fresh');f.db.run("UPDATE machines SET reachability='offline'");assert.equal(f.read().freshness,'stale');assert.equal(f.read().state,'running');
 f.advance(121000);assert.equal(f.read().items.length,0);
});
for(const terminal of ['turn.failed','turn.interrupted'])test(`panel reports running progress then honors native ${terminal} without waiting for success`,t=>{
 const f=fixture();t.after(()=>f.db.close());const panel=new PanelVoiceService(f.db,f.registry,new CoordinationService(f.db,f.config),f.progress);
 const call=panel.start(f.principal,'m',{});panel.state(call.voice_id,'active');
 const job=panel.tool(f.principal,call.voice_id,'dispatch',{action:'dispatch',sessionId:f.session.logicalSessionId,prompt:'Fixture task'}) as {commandId:string};
 f.running();f.event('turn.started',{commandId:job.commandId});f.event('item.started',{item:{id:'cmd',type:'commandExecution',command:'npm test'}});f.stream('cmd','Running checks');
 const live=panel.tool(f.principal,call.voice_id,'status',{action:'status'}) as {state:string;result:string;progress:{items:unknown[]}};
 assert.equal(live.state,'running');assert.equal(live.result,'');assert.equal(live.progress.items.length,1);
 assert.equal(panel.poll(f.principal,call.voice_id).report,null,'progress never triggers unsolicited spoken final results');
 f.event(terminal,{turn:{status:terminal==='turn.failed'?'failed':'interrupted'}});
 assert.equal(panel.poll(f.principal,call.voice_id).task?.state,terminal==='turn.failed'?'failed':'interrupted');
});
test('session status can expose native work without a coordinator job and never borrows another turn',t=>{
 const f=fixture();t.after(()=>f.db.close());f.running();f.stream('cmd','Ongoing work');
 const panel=new PanelVoiceService(f.db,f.registry,new CoordinationService(f.db,f.config),f.progress);const call=panel.start(f.principal,'m',{});panel.state(call.voice_id,'active');
 const value=panel.tool(f.principal,call.voice_id,'status',{action:'status',sessionId:f.session.logicalSessionId}) as {state:string;hasCoordinatorJob:boolean;sessionProgress:{items:unknown[]}};
 assert.equal(value.state,'running');assert.equal(value.hasCoordinatorJob,false);assert.equal(value.sessionProgress.items.length,1);
 assert.equal(f.progress.read(f.principal,f.session.logicalSessionId,null).items.length,0);
 assert.equal(f.progress.read(f.principal,f.session.logicalSessionId,'other-turn').items.length,0);
});
