import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {CollaborationService,validateTasks} from '../src/collaboration.js';

function fixture(){
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'collab@example.test',ADMIN_PASSWORD:'test-password-long',PUBLIC_ORIGIN:'http://panel.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const db=new ControlPlaneDatabase(':memory:');const {workspaceId}=db.bootstrap(config);const auth=new AuthService(db,config),principal=auth.servicePrincipal('collaboration-test');
 const at=new Date().toISOString();db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Fixture','linux','24','x64','0.30.94','online','compatible','["turn.start","turn.cancel"]',?,?,?)`,workspaceId,at,at,at);
 db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','p','Demo','/fixture','hash',?,?)",workspaceId,at,at);
 const registry=new RegistryService(db,config),coordination=new CoordinationService(db,config),session=registry.createSession(principal,'m','p','Test','collaboration-fixture');
 const dispatched:unknown[]=[];const service=new CollaborationService(db,registry,coordination,c=>dispatched.push(c));
 const input={title:'Prepare materials',sessionId:session.logicalSessionId,clientMutationId:'one',confirmed:true,tasks:[{title:'Research',prompt:'Read only, report facts.',sessionId:session.logicalSessionId,dependsOn:[]}]};
 return {db,principal,registry,coordination,service,session,input,dispatched};
}
test('rejects cycles, oversized and empty plans',()=>{
 assert.throws(()=>validateTasks([]));assert.throws(()=>validateTasks([{title:'a',prompt:'b',sessionId:'s',dependsOn:[0]}]));
 assert.throws(()=>validateTasks(Array.from({length:7},()=>({title:'a',prompt:'b',sessionId:'s',dependsOn:[]}))));
});
test('accepted plan uses one real command; duplicate and restart never replay it',t=>{
 const f=fixture();t.after(()=>f.db.close());const plan=f.service.create(f.principal,f.input);
 assert.equal(plan.tasks[0]!.state,'submitted');assert.equal(f.dispatched.length,1);assert.equal(f.service.create(f.principal,f.input).id,plan.id);
 assert.equal(f.dispatched.length,1);assert.throws(()=>f.service.create(f.principal,{...f.input,title:'Different'}),/已用于/);
 const restarted=new CollaborationService(f.db,f.registry,f.coordination,c=>f.dispatched.push(c));
 assert.equal(restarted.get(f.principal,plan.id).state,'paused');restarted.action(f.principal,plan.id,'resume');assert.equal(f.dispatched.length,1);
 assert.throws(()=>restarted.get({...f.principal,userId:'other'},plan.id),/没有/);
});
test('pending commands and unknown outcomes block dependent work',t=>{
 const f=fixture();t.after(()=>f.db.close());const plan=f.service.create(f.principal,{...f.input,tasks:[...f.input.tasks,{title:'Write',prompt:'Use research.',sessionId:f.session.logicalSessionId,dependsOn:[0]}]});
 assert.equal(plan.tasks[1]!.state,'waiting');
 f.db.run("UPDATE command_projection SET state='unknown' WHERE command_id=?",plan.tasks[0]!.commandId!);
 const uncertain=f.service.get(f.principal,plan.id);assert.equal(uncertain.tasks[0]!.state,'unknown');
 f.service.action(f.principal,plan.id,'pause');f.service.action(f.principal,plan.id,'resume');assert.equal(f.dispatched.length,1);
 assert.equal(f.service.get(f.principal,plan.id).tasks[1]!.state,'blocked');
 assert.throws(()=>f.service.action(f.principal,plan.id,'summarize'),/等待/);
});
test('other turn completion cannot finish a task; revoked results are not returned',t=>{
 const f=fixture();t.after(()=>f.db.close());const plan=f.service.create(f.principal,f.input),command=plan.tasks[0]!.commandId!;
 const event=(seq:number,type:string,body:unknown,turn='own-turn')=>{
 const ref=`payload-${seq}`,at=new Date().toISOString();f.db.run("INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)",ref,f.principal.workspaceId,JSON.stringify(body),'hash',at,'9999-12-31T00:00:00Z');
 f.db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state) VALUES(?,'hash','agent',?,?,?,'m','p',?,1,'native',?,?,'1',?,?,?,'present')`,`event-${seq}`,f.principal.workspaceId,f.session.logicalSessionId,f.session.executionSegmentId,seq,turn,type,at,at,ref);
 };
 event(1,'turn.started',{commandId:command});event(2,'turn.completed',{turn:{status:'completed'}},'unrelated');
 assert.equal(f.service.get(f.principal,plan.id).tasks[0]!.state,'running');
 event(3,'item.completed',{item:{type:'agentMessage',text:'Verified facts'}});event(4,'turn.completed',{turn:{status:'completed'}});
 assert.equal(f.service.get(f.principal,plan.id).tasks[0]!.result,'Verified facts');
 f.db.run("UPDATE durable_events SET native_item_id='final-item' WHERE session_seq=3");
 event(5,'item.completed',{item:{type:'agentMessage',text:'Unavailable'}});
 f.db.run("UPDATE durable_events SET native_item_id='final-item',payload_state='deleted' WHERE session_seq=5");
 assert.equal(f.service.get(f.principal,plan.id).tasks[0]!.result,'','a deleted revision must not resurrect older content');
 f.db.run("UPDATE projects SET sync_content=0 WHERE project_id='p'");assert.equal(f.service.get(f.principal,plan.id).tasks[0]!.result,'');
 assert.throws(()=>f.service.action(f.principal,plan.id,'summarize'),/不可读取/);
});
test('paused plan does not dispatch; cancellation preserves running task receipt',t=>{
 const f=fixture();t.after(()=>f.db.close());const plan=f.service.create(f.principal,{...f.input,tasks:[...f.input.tasks,{title:'Second',prompt:'Later',sessionId:f.session.logicalSessionId,dependsOn:[0]}]});
 const cancelled=f.service.action(f.principal,plan.id,'cancel');assert.equal(cancelled.tasks[1]!.state,'cancelled');assert.equal(cancelled.tasks[0]!.commandId,plan.tasks[0]!.commandId);
 assert.equal(f.dispatched.length,1);assert.throws(()=>f.service.action(f.principal,plan.id,'stop',0),/原生轮次/);
});

test('AI planning sends only a plan-mode task to the current conversation',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE machines SET codex_catalog_json=? WHERE machine_id='m'",JSON.stringify({models:[{model:'fixture',displayName:'Fixture',efforts:['medium'],defaultEffort:'medium'}],modes:['default','plan'],fetchedAt:new Date().toISOString()}));
 f.db.run('UPDATE logical_sessions SET runtime_settings_json=? WHERE logical_session_id=?',JSON.stringify({observed:{model:'fixture',observedAt:new Date().toISOString()}}),f.session.logicalSessionId);
 const plan=f.service.prepare(f.principal,{...f.input,candidates:[f.session.logicalSessionId]});
 assert.equal(plan.tasks.length,1);assert.equal(plan.tasks[0]!.planning,true);assert.equal(f.dispatched.length,1,JSON.stringify(plan));
 const command=f.dispatched[0] as {payload:{settings:{mode:string};prompt:string}};
 assert.equal(command.payload.settings.mode,'plan');assert.match(command.payload.prompt,/只拟定分工/);
 f.service.prepare(f.principal,{...f.input,candidates:[f.session.logicalSessionId]});assert.equal(f.dispatched.length,1);
});
