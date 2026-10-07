import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {PanelVoiceService} from '../src/panel-voice.js';
import {SessionProgressService} from '../src/session-progress.js';
import {SessionHistoryService} from '../src/session-history.js';
import {SessionHistoryBroker,type HistoryEndpoint} from '../src/session-history-broker.js';
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
function dialogue(f:ReturnType<typeof fixture>){
 f.event('turn.started',{});
 f.event('item.completed',{item:{id:'u',type:'userMessage',content:[{type:'text',text:'My question'}]}});
 const ref=f.event('item.completed',{item:{id:'a',type:'agentMessage',phase:'final_answer',text:'Verified final reply'}});
 f.event('turn.completed',{});return ref;
}
test('idle non-coordinator session returns actual durable conversation, independent of progress and jobs',async t=>{
 const f=fixture();t.after(()=>f.db.close());dialogue(f);
 const service=new SessionHistoryService(f.db,f.registry);
 const result=await service.read(f.principal,{sessionId:f.session.logicalSessionId,machineId:'m',projectId:'p'});
 assert.equal(result.latestRound.userInput?.text,'My question');assert.equal(result.latestRound.finalReply?.text,'Verified final reply');assert.equal(result.latestRound.complete,true);assert.equal(result.source,'synced_native_history');assert.equal(result.authoritative,false);assert.equal(result.nativeError,'HISTORY_UNSUPPORTED');
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM panel_voice_jobs')?.n,0);
 const panel=new PanelVoiceService(f.db,f.registry,new CoordinationService(f.db,f.config),f.progress,service);const call=panel.start(f.principal,'m',{});panel.state(call.voice_id,'active');
 const voice=await panel.history(f.principal,call.voice_id,{sessionId:f.session.logicalSessionId});assert.deepEqual(voice.items,result.items);
 await assert.rejects(panel.history({...f.principal,userId:'other'},call.voice_id,{sessionId:f.session.logicalSessionId}),{code:'PANEL_VOICE_OWNER'});
});
test('authorization, exact project/host/session, content policy and signed cursor enforce isolation',async t=>{
 const f=fixture();t.after(()=>f.db.close());dialogue(f);const service=new SessionHistoryService(f.db,f.registry);
 await assert.rejects(service.read(f.principal,{}),{code:'HISTORY_SESSION_REQUIRED'});
 await assert.rejects(service.read(f.principal,{sessionId:f.session.logicalSessionId,projectId:'wrong'}),{code:'HISTORY_TARGET_MISMATCH'});
 await assert.rejects(service.read({...f.principal,workspaceId:'other'},{sessionId:f.session.logicalSessionId}));
 const empty=f.registry.createSession(f.principal,'m','p','Empty','empty');assert.equal((await service.read(f.principal,{sessionId:empty.logicalSessionId})).items.length,0);
 f.db.run('UPDATE projects SET sync_content=0');await assert.rejects(service.read(f.principal,{sessionId:f.session.logicalSessionId}),{code:'HISTORY_CONTENT_DISABLED'});
});
test('offline, expired and deleted content are explicit and do not become an empty progress claim',async t=>{
 const f=fixture();t.after(()=>f.db.close());const ref=dialogue(f);const service=new SessionHistoryService(f.db,f.registry);
 f.db.run("UPDATE machines SET reachability='offline'");let result=await service.read(f.principal,{sessionId:f.session.logicalSessionId});assert.equal(result.nativeError,'HISTORY_HOST_OFFLINE');assert.equal(result.items.length,2);
 await assert.rejects(service.read(f.principal,{sessionId:f.session.logicalSessionId,source:'native'}),{code:'HISTORY_HOST_OFFLINE'});
 f.db.run("UPDATE content_blobs SET expires_at='2000-01-01' WHERE payload_ref=?",ref);result=await service.read(f.principal,{sessionId:f.session.logicalSessionId});assert.equal(result.latestRound.finalReply?.text,'');assert.deepEqual(result.unavailableReasons,['CONTENT_EXPIRED']);assert.equal(result.latestRound.complete,false);
 f.db.run("UPDATE content_blobs SET deleted_at='2000-01-01' WHERE payload_ref=?",ref);result=await service.read(f.principal,{sessionId:f.session.logicalSessionId});assert.deepEqual(result.unavailableReasons,['CONTENT_DELETED']);
});
test('full synced history pagination retains long message tails and scopes cursors to user/session/source',async t=>{
 const f=fixture();t.after(()=>f.db.close());const long='xyz'.repeat(18000);f.event('item.completed',{item:{id:'long',type:'agentMessage',phase:'final_answer',text:long}});
 for(let n=0;n<26;n++)f.event('item.completed',{item:{id:`i${n}`,type:'userMessage',content:[{type:'text',text:`Question ${n}`}]}});
 const service=new SessionHistoryService(f.db,f.registry);let result=await service.read(f.principal,{sessionId:f.session.logicalSessionId,source:'synced'});const first=result.nextCursor!;
 await assert.rejects(service.read({...f.principal,userId:'other'},{sessionId:f.session.logicalSessionId,cursor:first}),{code:'HISTORY_CURSOR_SCOPE'});
 await assert.rejects(service.read(f.principal,{sessionId:f.session.logicalSessionId,cursor:first,source:'native'}),{code:'HISTORY_CURSOR_SCOPE'});
 const chunks:string[]=[];let count=0;
 while(true){for(const item of result.items)if(item.id==='long')chunks.push(item.text);if(!result.nextCursor)break;result=await service.read(f.principal,{sessionId:f.session.logicalSessionId,cursor:result.nextCursor});assert.ok(++count<10);}
 assert.equal(chunks.join(''),long);
 f.db.run('UPDATE logical_sessions SET content_epoch=content_epoch+1');await assert.rejects(service.read(f.principal,{sessionId:f.session.logicalSessionId,cursor:first}),{code:'HISTORY_CURSOR_SCOPE'});
});
test('native reader validates identities and rechecks permissions after response without creating tasks',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.run("UPDATE execution_segments SET native_thread_id='native'");
 const page={nativeThreadId:'native',turnId:'t',turnStatus:'completed',items:[{id:'u',turnId:'t',role:'user',text:'Q',phase:null},{id:'a',turnId:'t',role:'assistant',text:'A',phase:'final_answer'}],nextCursor:null,truncated:false};
 let calls=0;const service=new SessionHistoryService(f.db,f.registry,async(binding)=>{assert.equal(binding.sessionId,f.session.logicalSessionId);calls++;return page;});
 const result=await service.read(f.principal,{sessionId:f.session.logicalSessionId});assert.equal(result.source,'codex_app_server');assert.equal(result.latestRound.finalReply?.text,'A');assert.equal(result.authoritative,true);assert.equal(calls,1);
 const wrong=new SessionHistoryService(f.db,f.registry,async()=>({...page,nativeThreadId:'other'}));await assert.rejects(wrong.read(f.principal,{sessionId:f.session.logicalSessionId}),{code:'HISTORY_INVALID'});
 const revoked=new SessionHistoryService(f.db,f.registry,async()=>{f.db.run('UPDATE projects SET sync_content=0');return page;});await assert.rejects(revoked.read(f.principal,{sessionId:f.session.logicalSessionId}),{code:'HISTORY_TARGET_CHANGED'});
 assert.equal(f.db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);
});
test('read broker correlates exact host/socket and rejects restart, disconnect and timeout',async()=>{
 const sent:Record<string,unknown>[]=[];let endpoint:HistoryEndpoint={key:{},generation:1,producerEpoch:'p',appServerEpoch:'a',supported:true,send:value=>{sent.push(value);return true;}};
 const broker=new SessionHistoryBroker(()=>endpoint,20);const binding={sessionId:'s',machineId:'m',projectId:'p',projectExternalId:'e',nativeThreadId:'t',executionSegmentId:'seg',contentEpoch:1};
 const pending=broker.read(binding,null);const id=sent[0]!.requestId as string;
 broker.receive('wrong',endpoint.key,{requestId:id,result:{wrong:true}});broker.receive('m',{}, {requestId:id,result:{wrong:true}});broker.receive('m',endpoint.key,{requestId:id,result:{correct:true}});assert.deepEqual(await pending,{correct:true});
 const changed=broker.read(binding,null);endpoint={...endpoint,appServerEpoch:'new'};broker.receive('m',endpoint.key,{requestId:sent[1]!.requestId as string,result:{}});await assert.rejects(changed,{code:'HISTORY_TARGET_CHANGED'});
 const closed=broker.read(binding,null);broker.disconnect('m',endpoint.key);await assert.rejects(closed,{code:'HISTORY_HOST_OFFLINE'});
 await assert.rejects(broker.read(binding,null),{code:'HISTORY_TIMEOUT'});broker.close();
});
test('deleted blobs containing JSON null and native rereads cannot resurrect hidden content',async t=>{
 const f=fixture();t.after(()=>f.db.close());const ref=dialogue(f);f.db.run("UPDATE execution_segments SET native_thread_id='native'");
 f.db.run("UPDATE content_blobs SET body_json='null',deleted_at='2000-01-01' WHERE payload_ref=?",ref);
 const service=new SessionHistoryService(f.db,f.registry,async()=>({nativeThreadId:'native',turnId:'turn-current',turnStatus:'completed',items:[{id:'a',turnId:'turn-current',role:'assistant',text:'Must not restore deleted text',phase:'final_answer'}],nextCursor:null,truncated:false}));
 const native=await service.read(f.principal,{sessionId:f.session.logicalSessionId});assert.equal(native.items[0]?.text,'');assert.deepEqual(native.unavailableReasons,['CONTENT_DELETED']);
 const synced=await service.read(f.principal,{sessionId:f.session.logicalSessionId,source:'synced'});assert.equal(synced.items.find(i=>i.id==='a')?.unavailableReason,'CONTENT_DELETED');
});

import {buildControlPlane} from '../src/server.js';
test('authenticated HTTP history route uses the requested session and rejects anonymous or foreign users',async t=>{
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'history@example.test',ADMIN_PASSWORD:'fixture-password',PUBLIC_ORIGIN:'http://fixture.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const {app,db}=await buildControlPlane(config);t.after(()=>app.close());const auth=new AuthService(db,config);
 const login=auth.login('history@example.test','fixture-password','127.0.0.1','fixture');
 const principal=login.principal,at=new Date().toISOString();
 db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('http-m',?,'key','http-fingerprint','Host','linux','24','x64','0.30.88','online','compatible','[]',?,?,?)`,principal.workspaceId,at,at,at);
 db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('http-p',?,'http-m','http-p','Demo','/fixture','hash',?,?)",principal.workspaceId,at,at);
 const registry=new RegistryService(db,config),session=registry.createSession(principal,'http-m','http-p','Empty','http-s');
 const url=`/api/sessions/${session.logicalSessionId}/conversation-history`;
 assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 const cookie=`${config.cookieName}=${login.sessionToken}`;
 const result=await app.inject({method:'GET',url,headers:{cookie}});assert.equal(result.statusCode,200,result.body);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.json().sessionId,session.logicalSessionId);assert.equal(result.json().items.length,0);
 const wrong=await app.inject({method:'GET',url:url+'?projectId=other',headers:{cookie}});assert.equal(wrong.statusCode,404);assert.equal(wrong.json().error.code,'HISTORY_TARGET_MISMATCH');
 const guest=auth.loginVerifiedIdentity({id:'guest-identity',email:'guest@example.test'},'127.0.0.1','fixture');
 assert.equal((await app.inject({method:'GET',url,headers:{cookie:`${config.cookieName}=${guest.sessionToken}`}})).statusCode,404);
 assert.equal(db.get<{n:number}>('SELECT count(*) n FROM commands')?.n,0);
});
