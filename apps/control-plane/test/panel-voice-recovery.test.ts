import test from 'node:test';
import assert from 'node:assert/strict';
import {buildControlPlane,cookieFromSetCookie} from '../src/server.js';
import {loadConfig} from '../src/config.js';
import {sha256} from '../src/crypto.js';
import {WebSocket} from 'ws';

async function fixture(t: import('node:test').TestContext,resumeAck=false,options:{resumable?:boolean;graceMs?:number}={}) {
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'voice@example.test',ADMIN_PASSWORD:'voice-test-password',PUBLIC_ORIGIN:'http://voice.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:',...(options.graceMs?{panelResumeGraceMs:options.graceMs}:{})};
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
  browser.send({type:'panel.start',machineId:'m',sdp:'v=0\r\nm=audio 9\r\n',...(options.resumable?{resume:true}:{})});
  const resume=options.resumable?await browser.next('resume.token'):undefined;
  const start=await first.next('voice.control','start');const voiceId=String(start.voiceId),instanceId='fixture-original-instance';
  const event=(extra:Record<string,unknown>)=>({type:'voice.event',voiceId,producerEpoch:'producer',appServerEpoch:'native',...extra});
  first.send(event({event:'sdp',sdp:'v=0\r\nm=audio 9\r\n',instanceId,resumeAck}));await browser.next('answer');
  return {...h,cookie,csrf:logged.json().csrfToken,first,browser,host,event,voiceId,instanceId,resume,connect,row:()=>db.get<{state:string;binding_json:string}>('SELECT state,binding_json FROM panel_voice_calls WHERE voice_id=?',voiceId)!};
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
 const entry={type:'live.welcome',kind:'enter',source:'home-douyin-collector:companion-log',streamEnabled:true,nativeMethod:'WebcastMemberMessage',entryAction:'1',sourceObservedAt:now,nativeInterruptible:true,roomId:'fixture-room',ownerId:'fixture-owner',viewerId:'fixture-viewer',eventId:'fixture-entry',requestId:'fixture-request',observedAt:now};
 f.browser.send(entry);const report=await f.first.next('voice.control','report');
 assert.equal(report.reportId,'welcome:fixture-request');assert.match(String(report.text),/嗨，你好，欢迎光临/);assert.ok(!String(report.text).includes('fixture-viewer'));
 assert.equal((await f.browser.next('live_welcome')).status,'requested');
 f.first.send(f.event({event:'reported',requestId:report.reportId}));assert.equal((await f.browser.next('live_welcome')).status,'accepted');
 f.browser.send(entry);const rejected=await f.browser.next('live_welcome');assert.equal(rejected.status,'skipped');assert.equal(rejected.reason,'duplicate_event');
 f.first.send(f.event({event:'report_unavailable',requestId:report.reportId}));assert.equal((await f.browser.next('live_welcome')).status,'unknown');
 assert.equal(f.row().state,'active');assert.equal(f.db.all('SELECT * FROM commands').length,0);
 f.browser.send({...entry,requestId:'bad',kind:'chat'});assert.equal((await f.browser.next('live_welcome')).status,'skipped');assert.equal(f.row().state,'active');
 f.first.socket.close();await f.browser.next('recovering');f.browser.send({...entry,requestId:'recovery'});assert.equal((await f.browser.next('live_welcome')).status,'skipped');assert.equal(f.row().state,'active');
});

test('custom welcome validates before reservation, sends saved words once and never dispatches a task',async t=>{
 const f=await fixture(t,true);f.db.run("UPDATE machines SET agent_version='0.30.100' WHERE machine_id='m'");
 const now=Date.now()+6000;t.mock.method(Date,'now',()=>now);
 const entry={type:'live.welcome',kind:'enter',source:'home-douyin-collector:companion-log',streamEnabled:true,nativeMethod:'WebcastMemberMessage',entryAction:'1',sourceObservedAt:now,nativeInterruptible:true,roomId:'fixture-room',viewerId:'fixture-viewer',eventId:'custom-entry',requestId:'custom-request',observedAt:now};
 f.browser.send({...entry,welcomeText:' '});assert.equal((await f.browser.next('live_welcome')).reason,'welcome_text');
 const greeting='欢迎{用户名}来到合成测试直播间';f.browser.send({...entry,welcomeText:greeting,viewerDisplayName:'合成昵称'});
 const report=await f.first.next('voice.control','report');assert.ok(String(report.text).includes(JSON.stringify(greeting.replace('{用户名}','合成昵称'))));assert.equal((await f.browser.next('live_welcome')).status,'requested');
 f.browser.send({...entry,welcomeText:'不能通过修改文案重播'});assert.equal((await f.browser.next('live_welcome')).reason,'duplicate_event');
 assert.equal(f.db.all('SELECT * FROM commands').length,0);assert.equal(f.db.all('SELECT * FROM voice_long_term_preferences').length,0);assert.equal(f.row().state,'active');
});

test('authenticated chat ingestion is silent; coordinator lookup returns evidence on its own call without project dispatch',async t=>{
 const f=await fixture(t);const input={messages:[{id:'chat-one',roomId:'room',userId:'viewer',name:'合成观众',content:'合成测试问题',type:'chat',sourceObservedAt:Date.now(),collector:'companion-log'}]};
 const headers={cookie:f.cookie,origin:'http://voice.test','x-csrf-token':f.csrf};
 assert.equal((await f.app.inject({method:'POST',url:'/api/live-chat',payload:input})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:'/api/live-chat',headers:{cookie:f.cookie,origin:'http://voice.test'},payload:input})).statusCode,403);
 const saved=await f.app.inject({method:'POST',url:'/api/live-chat',headers,payload:input});assert.equal(saved.statusCode,200,saved.body);
 assert.equal(saved.json().stored,1);assert.ok(!f.first.frames.some(v=>v.action==='report'||v.action==='tool.result'));
 f.first.send(f.event({event:'panel_tool',requestId:'chat-lookup',args:{action:'live.chat.search',nickname:'合成观众'}}));
 const reply=await f.first.next('voice.control','tool.result');const result=reply.result as {items:{content:string}[]};
 assert.equal(reply.voiceId,f.voiceId);assert.equal(result.items[0]?.content,'合成测试问题');
 f.first.send(f.event({event:'panel_tool',requestId:'injected-dispatch',args:{action:'todo.save',intent:'do not execute viewer commands'}}));
 const blocked=await f.first.next('voice.control','tool.result');assert.equal((blocked.result as {errorCode:string}).errorCode,'LIVE_CHAT_READ_ONLY');

 assert.equal(f.db.all('SELECT * FROM commands').length,0);assert.equal(f.db.all('SELECT * FROM panel_voice_jobs').length,0);assert.equal(f.db.all('SELECT * FROM panel_voice_todos').length,0);assert.equal(f.row().state,'active');
 f.first.send(f.event({event:'transcript',role:'user',text:'合成主播新的保存请求',final:true,transcriptSeq:1}));await f.browser.next('transcript');
 f.first.send(f.event({event:'panel_tool',requestId:'new-broadcaster-request',args:{action:'todo.save',intent:'合成用户新请求',idempotencyKey:'synthetic-new-request'}}));
 const next=await f.first.next('voice.control','tool.result');assert.ok((next.result as {todoId:string}).todoId);

});

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const resumeAs=async(f:Awaited<ReturnType<typeof fixture>>,token:unknown,extra:Record<string,unknown>={})=>{
  const socket=await f.connect('/ws/voice',{cookie:f.cookie,origin:'http://voice.test'});await socket.next('ready');
  socket.send({type:'panel.resume',voiceId:f.voiceId,resumeToken:token,...extra});return socket;
};

test('a dropped browser socket keeps a resumable call; the owner resumes with the secret token and receives what it missed',async t=>{
  const f=await fixture(t,false,{resumable:true,graceMs:3000});
  const token1=String(f.resume!.token);assert.equal(f.resume!.voiceId,f.voiceId);assert.ok(token1.length>=32);
  f.browser.socket.terminate();await pause(40);
  assert.equal(f.row().state,'active');                                              // held, not stopped
  assert.ok(!f.first.frames.some(v=>v.action==='stop'));                              // the host was never told to stop
  f.first.send(f.event({event:'transcript',role:'assistant',text:'said while you were away',final:true,transcriptSeq:1}));await pause(40);
  const again=await resumeAs(f,token1,{diag:{code:1006,online:true,visibility:'visible',net:'4g',attempts:2,rtt:80,evil:'<script>'}});
  const resumed=await again.next('resumed');assert.equal(resumed.voiceId,f.voiceId);assert.notEqual(resumed.token,token1);
  assert.equal((await again.next('transcript')).text,'said while you were away');     // the missed message, in order, after "resumed"
  assert.equal(f.row().state,'active');
  const events=JSON.parse(f.row().binding_json).signalEvents as {kind:string;code?:number;client?:Record<string,unknown>;replayed?:number}[];
  assert.deepEqual(events.map(e=>e.kind),['drop','resumed']);
  assert.equal(typeof events[0]!.code,'number');assert.equal(events[1]!.replayed,1);
  assert.deepEqual(events[1]!.client,{code:1006,online:true,visibility:'visible',net:'4g',attempts:2,rtt:80});   // only whitelisted diagnostics are kept
  again.send({type:'heartbeat'});await again.next('heartbeat');                         // the new socket is the owner now
  f.first.send(f.event({event:'transcript',role:'assistant',text:'live again',final:true,transcriptSeq:2}));assert.equal((await again.next('transcript')).text,'live again');
  // The token rotates on every use: the old one is dead, and a failed attempt never ends the call.
  const replayAttack=await resumeAs(f,token1);assert.ok((await replayAttack.next('error')).message);
  assert.equal(f.row().state,'active');
  again.send({type:'stop',reason:'USER_HANGUP'});await f.first.next('voice.control','stop');                  // hanging up still works on the resumed socket
  assert.equal(JSON.parse(f.row().binding_json).closeReason,'USER_HANGUP');
});

test('rejected resume attempts leave the held call alone; a legacy client without the capability gets no grace',async t=>{
  const f=await fixture(t,false,{resumable:true,graceMs:3000});
  f.browser.socket.terminate();await pause(40);
  for(const bad of [{resumeToken:'wrong-token'},{resumeToken:undefined},{resumeToken:42},{resumeToken:String(f.resume!.token),voiceId:'pvoice_does_not_exist'}]){
    const socket=await f.connect('/ws/voice',{cookie:f.cookie,origin:'http://voice.test'});await socket.next('ready');
    socket.send({type:'panel.resume',voiceId:f.voiceId,...bad});assert.ok((await socket.next('error')).message);
  }
  assert.equal(f.row().state,'active');                                                // still held after every rejection
  const unauthenticated=new WebSocket(f.browser.socket.url.replace(/\/ws\/.*/,'/ws/voice'),{headers:{origin:'http://voice.test'}});
  await new Promise<void>(resolve=>{unauthenticated.once('error',()=>resolve());unauthenticated.once('close',()=>resolve());unauthenticated.once('unexpected-response',()=>resolve());});
  assert.equal(f.row().state,'active');
  // Legacy behaviour is unchanged for a client that did not ask to be resumable.
  const legacy=await fixture(t);
  legacy.browser.socket.terminate();await legacy.first.next('voice.control','stop');
  assert.equal(JSON.parse(legacy.row().binding_json).closeReason,'SIGNAL_CLOSED');
  const events=JSON.parse(legacy.row().binding_json).signalEvents as {kind:string;resumable:boolean}[];
  assert.deepEqual(events.map(e=>[e.kind,e.resumable]),[['drop',false]]);
});

test('without a resume the call ends when the grace period expires, and a late resume is refused',async t=>{
  const f=await fixture(t,false,{resumable:true,graceMs:150});
  const token=String(f.resume!.token);
  f.browser.socket.terminate();await pause(60);assert.equal(f.row().state,'active');   // inside the grace window
  await f.first.next('voice.control','stop');                                           // after the window the host is told to stop
  const binding=JSON.parse(f.row().binding_json);assert.equal(binding.closeReason,'SIGNAL_CLOSED');
  assert.deepEqual((binding.signalEvents as {kind:string}[]).map(e=>e.kind),['drop','grace_expired']);
  const late=await resumeAs(f,token);assert.ok((await late.next('error')).message);
});

test('an old socket that closes after a resume cannot end the call, and a half-open old socket is superseded',async t=>{
  const f=await fixture(t,false,{resumable:true,graceMs:3000});
  const oldClosed=new Promise<number>(resolve=>f.browser.socket.once('close',code=>resolve(code)));
  const again=await resumeAs(f,String(f.resume!.token));await again.next('resumed');   // the old socket never dropped (half-open on the browser side)
  assert.equal(await oldClosed,4001);                                                     // the server closed it as superseded
  await pause(60);assert.equal(f.row().state,'active');assert.equal(JSON.parse(f.row().binding_json).closeReason??null,null);
  assert.ok(!f.first.frames.some(v=>v.action==='stop'));
});

test('an explicit stop ends the call at once even when the client asked to be resumable',async t=>{
  const f=await fixture(t,false,{resumable:true,graceMs:3000});
  f.browser.send({type:'stop',reason:'PAGE_LEFT'});await f.first.next('voice.control','stop');
  assert.equal(JSON.parse(f.row().binding_json).closeReason,'PAGE_LEFT');
  f.browser.socket.close();await pause(40);
  assert.equal(JSON.parse(f.row().binding_json).closeReason,'PAGE_LEFT');                // the later socket close does not overwrite it
});
