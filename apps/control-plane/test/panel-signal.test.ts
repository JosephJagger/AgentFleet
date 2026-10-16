import test from 'node:test';
import assert from 'node:assert/strict';
import {PanelChannel,cleanClientDiagnostics,type SocketLike} from '../src/panel-signal.js';

class FakeSocket implements SocketLike {
  readyState=1;sent:string[]=[];pings=0;closed:[number|undefined,string|undefined]|undefined;terminated=false;
  send(data:string){if(this.readyState!==1)throw new Error('closed');this.sent.push(data);}
  ping(){this.pings++;}
  close(code?:number,reason?:string){this.closed=[code,reason];this.readyState=3;}
  terminate(){this.terminated=true;this.readyState=3;}
}
const msg=(type:string,extra:Record<string,unknown>={})=>JSON.stringify({type,...extra});

test('a non-resumable channel is a plain socket and cannot detach',()=>{
  const raw=new FakeSocket(),ch=new PanelChannel(raw);
  ch.send('a');assert.deepEqual(raw.sent,['a']);assert.equal(ch.resumable,false);assert.equal(ch.currentToken(),undefined);
  assert.equal(ch.detach(1000,()=>assert.fail('must not expire')),false);assert.equal(ch.detached,false);
  ch.ping();assert.equal(raw.pings,1);assert.equal(ch.matches('anything'),false);
});

test('a detached channel queues in order, reports OPEN so senders keep working, and replays on attach',()=>{
  const raw=new FakeSocket(),ch=new PanelChannel(raw,true);
  const token=ch.currentToken()!;assert.ok(token.length>=32);assert.equal(ch.matches(token),true);
  assert.equal(ch.detach(60_000,()=>undefined),true);
  raw.readyState=3;assert.equal(ch.detached,true);assert.equal(ch.readyState,1);assert.ok(ch.detachedAt!==undefined);
  ch.ping();assert.equal(raw.pings,0);                                                   // no ping into a dead socket
  ch.send(msg('transcript',{text:'1'}));ch.send(msg('panel_task'));ch.send(msg('transcript',{text:'2'}));assert.equal(ch.queued,3);
  const next=new FakeSocket();const attached=ch.attach(next);
  assert.equal(ch.matches(token),false);assert.ok(ch.currentToken()!==token);            // the token rotated
  assert.equal(ch.detached,false);assert.equal(ch.isCurrent(next),true);assert.equal(ch.isCurrent(raw),false);
  next.send(msg('resumed'));                                                              // the caller replies first ...
  assert.equal(attached.flush(),3);                                                       // ... then the queue is delivered in order
  assert.deepEqual(next.sent.map(v=>JSON.parse(v).text??JSON.parse(v).type),['resumed','1','panel_task','2']);
  assert.equal(attached.flush(),0);ch.send('live');assert.equal(next.sent.at(-1),'live');
  assert.equal(ch.resumes,1);
});

test('attach supersedes a still-open old socket with close code 4001',()=>{
  const raw=new FakeSocket(),ch=new PanelChannel(raw,true);
  const next=new FakeSocket();ch.attach(next);
  assert.deepEqual(raw.closed,[4001,'superseded']);assert.equal(ch.isCurrent(raw),false);
});

test('the grace timer ends an unclaimed detach exactly once, and attach cancels it',async()=>{
  let expired=0;const ch=new PanelChannel(new FakeSocket(),true);
  ch.detach(30,()=>{expired++;});await new Promise(r=>setTimeout(r,80));assert.equal(expired,1);
  const ch2=new PanelChannel(new FakeSocket(),true);ch2.detach(30,()=>{expired++;});ch2.attach(new FakeSocket());await new Promise(r=>setTimeout(r,80));assert.equal(expired,1);
  const ch3=new PanelChannel(new FakeSocket(),true);ch3.detach(30,()=>{expired++;});ch3.dispose();await new Promise(r=>setTimeout(r,80));assert.equal(expired,1);
});

test('a full queue drops the oldest ordinary message but keeps critical ones',()=>{
  const ch=new PanelChannel(new FakeSocket(),true);ch.detach(60_000,()=>undefined);
  ch.send(msg('answer',{sdp:'v=0'}));
  for(let i=0;i<450;i++)ch.send(msg('transcript',{text:String(i)}));
  assert.equal(ch.queued,400);
  const next=new FakeSocket();const attached=ch.attach(next);attached.flush();
  const types=next.sent.map(v=>JSON.parse(v));
  assert.equal(types[0].type,'answer');                                                   // the SDP answer survived the overflow
  assert.equal(types.at(-1).text,'449');                                                  // the newest transcript survived too
  assert.ok(!types.some(v=>v.text==='0'));                                                // the oldest ordinary ones were dropped
});

test('close ends the channel: no more queueing, no reattach side effects, timer cleared',async()=>{
  let expired=0;const raw=new FakeSocket(),ch=new PanelChannel(raw,true);
  ch.detach(30,()=>{expired++;});ch.close(1000,'done');await new Promise(r=>setTimeout(r,80));
  assert.equal(expired,0);assert.throws(()=>ch.send('x'));assert.equal(ch.readyState,3);
  const open=new FakeSocket(),live=new PanelChannel(open,true);live.close(4000,'end');assert.deepEqual(open.closed,[4000,'end']);
});

test('resume tokens are compared in constant time and only accept strings',()=>{
  const ch=new PanelChannel(new FakeSocket(),true);const token=ch.currentToken()!;
  for(const bad of [undefined,null,42,{},[],'','x'.repeat(500),token.slice(0,-1),token+'0'])assert.equal(ch.matches(bad),false);
  assert.equal(ch.matches(token),true);
});

test('client diagnostics keep only a small typed whitelist',()=>{
  assert.deepEqual(cleanClientDiagnostics({code:1006,wasClean:false,online:true,visibility:'visible',net:'4g',attempts:3,rtt:120.4,downlink:9.87,lastMessageMs:5400,callAgeSec:900,reason:'x'.repeat(100),evil:'<script>',nested:{a:1}}),
    {code:1006,attempts:3,lastMessageMs:5400,callAgeSec:900,rtt:120,wasClean:false,online:true,downlink:9.9,visibility:'visible',net:'4g',reason:'x'.repeat(40)});
  for(const bad of [null,undefined,'x',42,[],()=>1])assert.deepEqual(cleanClientDiagnostics(bad),{});
  assert.deepEqual(cleanClientDiagnostics({code:Infinity,rtt:NaN,visibility:{}}),{});
  assert.equal(cleanClientDiagnostics({net:'a<b>c d/e'}).net,'abc d/e');
});
