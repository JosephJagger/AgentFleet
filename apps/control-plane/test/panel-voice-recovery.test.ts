import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControlPlane,cookieFromSetCookie} from '../src/server.js';
import {loadConfig} from '../src/config.js';
import {sha256} from '../src/crypto.js';
import {WebSocket} from 'ws';

async function fixture(t: import('node:test').TestContext,resumeAck=false) {
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'voice@example.test',ADMIN_PASSWORD:'voice-test-password',PUBLIC_ORIGIN:'http://voice.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const h=await buildControlPlane(config);const {app,db}=h;const address=await app.listen({host:"127.0.0.1",port:0});
  const sockets:WebSocket[]=[];
  t.after(async()=>{
    const closed=[...app.websocketServer.clients].map(socket=>new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.terminate();}));
    for(const socket of sockets)socket.terminate();await Promise.all(closed);await new Promise(r=>setImmediate(r));await app.close();
  });
  const logged=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:'http://voice.test'},payload:{email:config.adminEmail,password:config.adminPassword}});
  assert.equal(logged.statusCode,200);
  const cookie=cookieFromSetCookie(logged.headers['set-cookie']);
  const workspace=db.get<{workspace_id:string}>('SELECT workspace_id FROM workspaces')!.workspace_id;
  const now=new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Fixture','linux','24','x64','0.30.99','online','compatible','[]',?,?,?)`,workspace,now,now,now);
  async function connect(path:string,headers:Record<string,string>={}) {
    const frames:Record<string,unknown>[]=[];
    const socket=new WebSocket(address.replace('http:','ws:')+path,{headers});socket.on('message',raw=>frames.push(JSON.parse(raw.toString())));sockets.push(socket);await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    return {socket,frames,send:(value:unknown)=>socket.send(JSON.stringify(value)),next:async(type:string,action?:string)=>{
      for(let i=0;i<200;i++) {const index=frames.findIndex(v=>v.type===type&&(!action||v.action===action));if(index>=0)return frames.splice(index,1)[0]!;await new Promise(r=>setTimeout(r,5));}
      throw Error(`Missing ${type}/${action}: ${JSON.stringify(frames)}`);
    }};
  }
  async function host(generation:number,producerEpoch='producer') {
    const ticket=`fixture-${generation}`;
    db.run("INSERT INTO agent_tickets(ticket_id,machine_id,token_hash,audience,transport_generation,created_at,expires_at) VALUES(?,'m',?,'agent-ws',?,?,?)",ticket,sha256(ticket),generation,new Date().toISOString(),new Date(Date.now()+60000).toISOString());
    const c=await connect(`/ws/agent?ticket=${ticket}`);await c.next('welcome');
    const streams=[{producerEpoch,throughHostSeq:0}];
    c.send({type:'hello',producerEpoch,appServerEpoch:'native',agentVersion:'0.30.99',codexVersion:'0.154.0',schemaHash:'f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9',credentialProtectionLevel:'software_protected',platform:'linux',platformRelease:'24',architecture:'x86_64',capacity:'idle',capabilities:{realtimeVoice:true,commandTypes:[]},projects:[],sessions:[],reconciliationStreams:streams});
    const ack=await c.next('hello.ack');c.send({type:'reconciliation.complete',reconciliationId:ack.reconciliationId,reconciliationStreams:streams});await c.next('reconciliation.ack');return c;
  }
  const first=await host(1);const browser=await connect('/ws/voice',{cookie,origin:'http://voice.test'});await browser.next('ready');
  browser.send({type:'panel.start',machineId:'m',sdp:'v=0\r\nm=audio 9\r\n'});
  const start=await first.next('voice.control','start');const voiceId=String(start.voiceId),instanceId='fixture-original-instance';
  const event=(extra:Record<string,unknown>)=>({type:'voice.event',voiceId,producerEpoch:'producer',appServerEpoch:'native',...extra});
  first.send(event({event:'sdp',sdp:'v=0\r\nm=audio 9\r\n',instanceId,resumeAck}));await browser.next('answer');
  return {...h,first,browser,host,event,voiceId,instanceId,row:()=>db.get<{state:string;binding_json:string}>('SELECT state,binding_json FROM panel_voice_calls WHERE voice_id=?',voiceId)!};
}

test('short host reconnect restores only original call; stale proof and duplicate proof cannot rebind or start calls',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');
  const next=await f.host(2);const probe=await next.next('voice.control','probe');
  next.send(f.event({event:'recovery',requestId:'old-nonce',recoveryState:'present',instanceId:f.instanceId}));
  assert.equal((await next.next('error')).code,'VOICE_FENCED');assert.equal(JSON.parse(f.row().binding_json).transportGeneration,1);
  next.send(f.event({event:'panel_tool',requestId:'unsafe',args:{action:'dispatch'}}));assert.equal((await next.next('error')).code,'VOICE_FENCED');
  const proof=f.event({event:'recovery',requestId:probe.requestId,recoveryState:'present',instanceId:f.instanceId});next.send(proof);
  const resume=await next.next('voice.control','resume');assert.equal(resume.instanceId,f.instanceId);await f.browser.next('recovered');
  assert.equal(JSON.parse(f.row().binding_json).transportGeneration,2);assert.equal(f.row().state,'active');
  next.send(proof);assert.equal((await next.next('error')).code,'VOICE_FENCED');
  assert.equal(next.frames.filter(v=>v.action==='start').length,0);assert.equal(f.db.all('SELECT * FROM commands').length,0);
});

test('hangup while disconnected never resumes and waits for native stop confirmation',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');f.browser.send({type:'stop',reason:'USER_HANGUP'});
  await new Promise(r=>setTimeout(r,10));assert.equal(f.row().state,'closing');
  const next=await f.host(2);const probe=await next.next('voice.control','probe');
  next.send(f.event({event:'recovery',requestId:probe.requestId,recoveryState:'present',instanceId:f.instanceId}));await next.next('voice.control','stop');
  assert.equal(f.row().state,'closing');assert.ok(!next.frames.some(v=>v.action==='resume'||v.action==='start'));
  next.send(f.event({event:'stopped'}));await new Promise(r=>setTimeout(r,10));assert.equal(f.row().state,'closed');
});

test('absent native call after process restart closes original browser without creating another call',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');
  const next=await f.host(2,'new-producer');const probe=await next.next('voice.control','probe');
  next.send(f.event({producerEpoch:'new-producer',event:'recovery',requestId:probe.requestId,recoveryState:'absent'}));await f.browser.next('error');
  assert.equal(f.row().state,'closed');assert.equal(JSON.parse(f.row().binding_json).closeReason,'VOICE_PROCESS_CHANGED');assert.ok(!next.frames.some(v=>v.action==='start'||v.action==='resume'));
});

test('recovery deadline ends browser but unknown native ownership remains reserved for cleanup',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');
  t.mock.timers.enable({apis:['Date'],now:Date.now()+61000});f.runMaintenance();await f.browser.next('error');
  assert.equal(f.row().state,'closing');assert.equal(JSON.parse(f.row().binding_json).closeReason,'HOST_RECOVERY_TIMEOUT');
  const next=await f.host(2);const probe=await next.next('voice.control','probe');
  next.send(f.event({event:'recovery',requestId:probe.requestId,recoveryState:'unknown'}));await new Promise(r=>setTimeout(r,10));
  assert.equal(f.row().state,'closing');assert.ok(!next.frames.some(v=>v.action==='resume'||v.action==='start'));
});

test('proof from a superseded connection and a different native instance cannot resume original call',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');
  const second=await f.host(2);const old=await second.next('voice.control','probe');
  const third=await f.host(3);const current=await third.next('voice.control','probe');
  third.send(f.event({event:'recovery',requestId:old.requestId,recoveryState:'present',instanceId:f.instanceId}));assert.equal((await third.next('error')).code,'VOICE_FENCED');
  third.send(f.event({event:'recovery',requestId:current.requestId,recoveryState:'present',instanceId:'different-instance'}));
  await new Promise(r=>setTimeout(r,10));assert.equal(JSON.parse(f.row().binding_json).transportGeneration,1);
  third.send(f.event({event:'recovery',recoveryState:'absent'}));assert.equal((await third.next('error')).code,'VOICE_FENCED');
  assert.equal(f.row().state,'active');assert.ok(!third.frames.some(v=>v.action==='start'||v.action==='resume'));
});

test('changed coordinator epoch cannot restore even matching instance; confirmed stop releases cleanup',async t=>{
  const f=await fixture(t);f.first.socket.close();await f.browser.next('recovering');
  const next=await f.host(2,'new-producer');const probe=await next.next('voice.control','probe');
  next.send(f.event({producerEpoch:'new-producer',event:'recovery',requestId:probe.requestId,recoveryState:'present',instanceId:f.instanceId}));
  await f.browser.next('error');await next.next('voice.control','stop');assert.equal(f.row().state,'closing');
  assert.ok(!next.frames.some(v=>v.action==='start'||v.action==='resume'));
  next.send(f.event({producerEpoch:'new-producer',event:'stopped'}));await new Promise(r=>setTimeout(r,10));assert.equal(f.row().state,'closed');
});

test('new host resume must be acknowledged before recovery UI clears; old nonce and hangup stay fenced',async t=>{
 const f=await fixture(t,true);f.first.socket.close();await f.browser.next('recovering');
 const next=await f.host(2);const probe=await next.next('voice.control','probe');
 next.send(f.event({event:'recovery',requestId:probe.requestId,recoveryState:'present',instanceId:f.instanceId}));
 const resume=await next.next('voice.control','resume');
 assert.ok(!f.browser.frames.some(x=>x.type==='recovered'));
 next.send(f.event({event:'resumed',requestId:'stale',instanceId:f.instanceId}));assert.equal((await next.next('error')).code,'VOICE_FENCED');
 next.send(f.event({event:'resumed',requestId:resume.requestId,instanceId:f.instanceId}));await f.browser.next('recovered');
 next.send(f.event({event:'resumed',requestId:resume.requestId,instanceId:f.instanceId}));assert.equal((await next.next('error')).code,'VOICE_FENCED');
 assert.equal(f.db.all('SELECT * FROM commands').length,0);
});

test('hangup between continuity proof and resume ack cannot revive the original call',async t=>{
 const f=await fixture(t,true);f.first.socket.close();await f.browser.next('recovering');
 const next=await f.host(2);const probe=await next.next('voice.control','probe');
 next.send(f.event({event:'recovery',requestId:probe.requestId,recoveryState:'present',instanceId:f.instanceId}));const resume=await next.next('voice.control','resume');
 f.browser.send({type:'stop',reason:'USER_HANGUP'});await next.next('voice.control','stop');
 next.send(f.event({event:'resumed',requestId:resume.requestId,instanceId:f.instanceId}));assert.equal((await next.next('error')).code,'VOICE_FENCED');
 assert.equal(f.row().state,'closing');assert.ok(!f.browser.frames.some(x=>x.type==='recovered'));
 next.send(f.event({event:'stopped'}));await new Promise(r=>setTimeout(r,10));assert.equal(f.row().state,'closed');
});

test('failed report delivery warns browser without ending call or altering tasks',async t=>{
 const f=await fixture(t);f.first.send(f.event({event:'report_unavailable',requestId:'job'}));
 await f.browser.next('report_unavailable');assert.equal(f.row().state,'active');assert.equal(f.browser.socket.readyState,WebSocket.OPEN);
 assert.ok(!f.first.frames.some(v=>v.action==='stop'||v.action==='start'));
});

test('optional live welcome uses native report once, keeps failures nonfatal and never creates tasks',async t=>{
 const f=await fixture(t,true);f.db.run("UPDATE machines SET agent_version='0.30.100' WHERE machine_id='m'");
 const original=Date.now;const now=original()+6000;t.mock.method(Date,'now',()=>now);
 const entry={type:'live.welcome',kind:'enter',source:'home-douyin-collector:companion-log',streamEnabled:true,nativeMethod:'WebcastMemberMessage',entryAction:'1',sourceObservedAt:now,audioIdle:true,roomId:'fixture-room',ownerId:'fixture-owner',viewerId:'fixture-viewer',eventId:'fixture-entry',requestId:'fixture-request',observedAt:now};
 f.browser.send(entry);const report=await f.first.next('voice.control','report');
 assert.equal(report.reportId,'welcome:fixture-request');assert.match(String(report.text),/嗨，你好，欢迎光临/);assert.ok(!String(report.text).includes('fixture-viewer'));
 assert.equal((await f.browser.next('live_welcome')).status,'requested');
 f.first.send(f.event({event:'reported',requestId:report.reportId}));assert.equal((await f.browser.next('live_welcome')).status,'accepted');
 f.browser.send(entry);assert.equal((await f.browser.next('live_welcome')).status,'skipped');
 f.first.send(f.event({event:'report_unavailable',requestId:report.reportId}));assert.equal((await f.browser.next('live_welcome')).status,'unknown');
 assert.equal(f.row().state,'active');assert.equal(f.db.all('SELECT * FROM commands').length,0);
 f.browser.send({...entry,requestId:'bad',kind:'chat'});assert.equal((await f.browser.next('live_welcome')).status,'skipped');assert.equal(f.row().state,'active');
 f.first.socket.close();await f.browser.next('recovering');f.browser.send({...entry,requestId:'recovery'});assert.equal((await f.browser.next('live_welcome')).status,'skipped');assert.equal(f.row().state,'active');
});
