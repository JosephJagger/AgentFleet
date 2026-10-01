import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { AuthService } from "../src/auth.js";
import { RegistryService, type AgentConnectionIdentity } from "../src/registry.js";
import { CoordinationService } from "../src/coordination.js";
import { NativeVoiceService, validVoiceOffer } from "../src/native-voice.js";
import type { DurableAgentEvent, LogicalSessionSummary } from "../src/api-schema.js";

function fixture() {
  const config={...loadConfig({AUTH_MODE:"password",ADMIN_EMAIL:"voice@example.test",ADMIN_PASSWORD:"voice-fixture-password",PUBLIC_ORIGIN:"http://voice.test",COOKIE_SECURE:"false",LOG_LEVEL:"silent"}),databasePath:":memory:"};
  const db=new ControlPlaneDatabase(":memory:"); const {workspaceId}=db.bootstrap(config);
  const auth=new AuthService(db,config); const principal=auth.servicePrincipal("voice-fixture");
  const at=new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at) VALUES('m',?,'key','fingerprint','Voice','linux','24','x64','0.30.61','active','normal','online','compatible','idle',?,?)`,workspaceId,at,at);
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','p','Voice','/fixture','hash',?,?)",workspaceId,at,at);
  db.run("INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES('s',?,'m','p','Voice',1,'idle','live',?,?)",workspaceId,at,at);
  db.run("INSERT INTO control_leases(control_lease_id,logical_session_id,holder_client_session_id,version,state,acquired_at,renewed_at,expires_at) VALUES('lease','s',?,1,'active',?,?,'9999-12-31T23:59:59.999Z')",principal.clientSessionId,at,at);
  db.run("INSERT INTO producer_streams(machine_id,producer_epoch,updated_at) VALUES('m','producer',?)",at);
  const session={logicalSessionId:"s",projectId:"p",machineId:"m",executionSegmentId:"segment",nativeThreadId:"native",contentEpoch:1,managed:true,reachability:"live",actions:{start:{allowed:true}}} as LogicalSessionSummary;
  const registry={getSession:()=>session} as unknown as RegistryService;
  const voice=new NativeVoiceService(db,registry);
  const connection={producerEpoch:"producer",appServerEpoch:"native-epoch",transportGeneration:1};
  return {config,db,principal,auth,voice,connection,registry};
}

test("voice metadata reserves one project, respects account leases, and waits for the durable event boundary before releasing",t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.throws(()=>f.voice.start(f.principal,"s","wrong",f.connection),/控制权/);
  const binding=f.voice.start(f.principal,"s","lease",f.connection);
  assert.equal(f.voice.validOwner(f.voice.get(binding.voiceId)!),true);
  assert.throws(()=>f.voice.start(f.principal,"s","lease",f.connection),/已有语音/);
  f.voice.stopped(binding.voiceId,2);
  assert.equal(f.voice.finish(f.voice.get(binding.voiceId)!),false);
  f.db.run("UPDATE producer_streams SET next_expected_host_seq=3");
  assert.equal(f.voice.finish(f.voice.get(binding.voiceId)!),true);
  assert.equal(f.voice.get(binding.voiceId)?.state,"closed");
  assert.doesNotThrow(()=>f.voice.start(f.principal,"s","lease",f.connection));
  assert.equal(f.db.get<{n:number}>("SELECT COUNT(*) AS n FROM commands")?.n,0);
});

test("voice-origin turns require exact native/session/producer bindings and cannot seize a competing project task",t=>{
  const f=fixture();t.after(()=>f.db.close());
  const binding=f.voice.start(f.principal,"s","lease",f.connection);
  const coordinator=new CoordinationService(f.db,f.config);
  const activate=(coordinator as unknown as {activateProjectTurnReservation(c:AgentConnectionIdentity,e:DurableAgentEvent,at:string):boolean}).activateProjectTurnReservation.bind(coordinator);
  const connection={machineId:"m"} as AgentConnectionIdentity;
  const event={...binding,nativeTurnId:"turn",type:"turn.started",payload:{voiceSessionId:binding.voiceId}} as unknown as DurableAgentEvent;
  assert.equal(activate(connection,{...event,appServerEpoch:"wrong"},new Date().toISOString()),false);
  assert.equal(activate(connection,{...event,nativeThreadId:"wrong"},new Date().toISOString()),false);
  assert.equal(activate(connection,event,new Date().toISOString()),true);
  assert.equal(activate(connection,event,new Date().toISOString()),true);
  assert.equal(activate(connection,{...event,nativeTurnId:"other"},new Date().toISOString()),false);
  const reservation=f.db.get<{command_id:string|null,native_turn_id:string}>("SELECT command_id,native_turn_id FROM project_turn_reservations");
  assert.equal(reservation?.command_id,null); assert.equal(reservation?.native_turn_id,"turn");
});

test("voice supports another browser of the same account but stops on lease expiry or owner revocation",t=>{
  const f=fixture();t.after(()=>f.db.close());
  const browser=f.auth.servicePrincipal("other-browser");
  const binding=f.voice.start(browser,"s","lease",f.connection);
  const row=f.voice.get(binding.voiceId)!;
  assert.equal(f.voice.validOwner(row),true);
  f.db.run("UPDATE client_sessions SET revoked_at=? WHERE client_session_id=?",new Date().toISOString(),browser.clientSessionId);
  assert.equal(f.voice.validOwner(row),false);
});

test("offers require bounded native audio SDP; unknown voice never unlocks from time passing alone",t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.equal(validVoiceOffer("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"),true);
  for(const sdp of [null,"https://external.test","v=0\r\nm=video 9",`v=0\r\nm=audio ${"x".repeat(65536)}`]) assert.equal(validVoiceOffer(sdp),false);
  const binding=f.voice.start(f.principal,"s","lease",f.connection);
  f.voice.state(binding.voiceId,"unknown");
  assert.equal(f.voice.finish(f.voice.get(binding.voiceId)!),false);
  assert.throws(()=>f.voice.start(f.principal,"s","lease",f.connection),/确认上次连接/);
});

test("voice signaling requires the authenticated same-origin browser and never persists an invalid offer",async t=>{
  const {buildControlPlane,cookieFromSetCookie}=await import('../src/server.js');
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'voice-ws@example.test',ADMIN_PASSWORD:'voice-socket-fixture-password',PUBLIC_ORIGIN:'http://voice.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const {app,db}=await buildControlPlane(config);t.after(()=>app.close());await app.ready();
  const logged=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'http://voice.test'},payload:{email:config.adminEmail,password:config.adminPassword}});
  assert.equal(logged.statusCode,200);
  const cookie=cookieFromSetCookie(logged.headers['set-cookie']);
  await assert.rejects(app.injectWS('/ws/voice',{headers:{origin:'http://voice.test'}}));
  await assert.rejects(app.injectWS('/ws/voice',{headers:{cookie,origin:'http://different.test'}}));
  const frames:Record<string,unknown>[]=[];
  let errorReceived!:(value:Record<string,unknown>)=>void;
  const error=new Promise<Record<string,unknown>>(resolve=>{errorReceived=resolve;});
  const socket=await app.injectWS('/ws/voice',{headers:{cookie,origin:'http://voice.test'}},{onInit:socket=>socket.on('message',raw=>{const value=JSON.parse(raw.toString()) as Record<string,unknown>;frames.push(value);if(value.type==='error')errorReceived(value);})});
  t.after(()=>socket.terminate());
  socket.send(JSON.stringify({type:'start',logicalSessionId:'forbidden',leaseId:'none',sdp:'https://external.test'}));
  const timer=setTimeout(()=>errorReceived({type:'timeout'}),2000);
  const rejected=await error;clearTimeout(timer);
  assert.equal(rejected.type,'error');assert.ok(frames.some(frame=>frame.type==='ready'));
  assert.equal(db.get<{n:number}>('SELECT COUNT(*) AS n FROM voice_sessions')?.n,0);
  assert.equal(db.get<{n:number}>('SELECT COUNT(*) AS n FROM commands')?.n,0);
});

test("authenticated voice heartbeats renew only their bound lease and tolerate delayed UI requests", t => {
  const f=fixture();t.after(()=>f.db.close());
  const initial=Date.now();
  t.mock.timers.enable({apis:["Date"],now:initial});
  f.db.run("UPDATE control_leases SET expires_at=?",new Date(initial+45000).toISOString());
  const binding=f.voice.start(f.principal,"s","lease",f.connection);
  const coordinator=new CoordinationService(f.db,f.config);
  f.voice.keepAlive(f.principal,binding.voiceId,coordinator);
  assert.equal(Date.parse(f.db.get<{expires_at:string}>("SELECT expires_at FROM control_leases")!.expires_at),initial+120000);
  t.mock.timers.setTime(initial+70000); // Old 45-second lease would already have expired.
  f.voice.keepAlive(f.principal,binding.voiceId,coordinator);
  assert.equal(Date.parse(f.db.get<{expires_at:string}>("SELECT expires_at FROM control_leases")!.expires_at),initial+190000);
  for(let i=1;i<=40;i++) {
    t.mock.timers.setTime(initial+70000+i*60000);
    f.voice.keepAlive(f.principal,binding.voiceId,coordinator);
  }
  assert.equal(f.voice.validOwner(f.voice.get(binding.voiceId)!),true,"an active call keeps its lease after 30 minutes");
  t.mock.timers.setTime(initial+70000+40*60000+120001);
  assert.throws(()=>f.voice.keepAlive(f.principal,binding.voiceId,coordinator),/控制权/);
  assert.equal(f.voice.validOwner(f.voice.get(binding.voiceId)!),false,"an expired lease cannot be resurrected");
});

test("voice keepalive cannot cross sockets, resume closed calls or outlive account revocation",t=>{
  const f=fixture();t.after(()=>f.db.close());
  const binding=f.voice.start(f.principal,"s","lease",f.connection);
  const coordinator=new CoordinationService(f.db,f.config);
  const browser=f.auth.servicePrincipal("other-voice-browser");
  assert.throws(()=>f.voice.keepAlive(browser,binding.voiceId,coordinator),/控制权/);
  f.voice.state(binding.voiceId,"closed");
  assert.throws(()=>f.voice.keepAlive(f.principal,binding.voiceId,coordinator),/控制权/);
  const next=f.voice.start(f.principal,"s","lease",f.connection);
  f.db.run("UPDATE client_sessions SET revoked_at=? WHERE client_session_id=?",new Date().toISOString(),f.principal.clientSessionId);
  assert.throws(()=>f.voice.keepAlive(f.principal,next.voiceId,coordinator),/控制权/);
});

test("voice close diagnostics preserve the first bounded cause and reject arbitrary content",t=>{
 const f=fixture();t.after(()=>f.db.close());
 const binding=f.voice.start(f.principal,"s","lease",f.connection);
 f.voice.recordCloseReason(binding.voiceId,"private transcript or SDP");
 assert.equal(JSON.parse(f.voice.get(binding.voiceId)!.binding_json).closeReason,undefined);
 f.voice.recordCloseReason(binding.voiceId,"AUDIO_FAILED");
 f.voice.recordCloseReason(binding.voiceId,"SIGNAL_CLOSED");
 assert.equal(JSON.parse(f.voice.get(binding.voiceId)!.binding_json).closeReason,"AUDIO_FAILED");
});
