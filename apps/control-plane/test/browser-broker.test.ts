import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserBroker,type BrowserEndpoint} from '../src/browser-broker.js';
const binding={machineId:'m',sessionId:'s',projectId:'p',projectExternalId:'external',nativeThreadId:'native',executionSegmentId:'segment',contentEpoch:1};
test('browser replies are fenced by host, connection and generation',async()=>{
 let request:Record<string,unknown>={};const key={};const endpoint:BrowserEndpoint={key,generation:1,producerEpoch:'p',appServerEpoch:'a',supported:true,send:value=>{request=value;return true;}};
 const broker=new BrowserBroker(()=>endpoint);
 const result=broker.control(binding,{action:'snapshot'});broker.receive('wrong',key,{requestId:String(request.requestId),result:{image:'wrong'}});
 broker.receive('m',key,{requestId:String(request.requestId),result:{image:'right'}});assert.deepEqual(await result,{image:'right'});broker.close();
});
test('disconnect rejects an uncertain action and never replays it',async()=>{
 let sends=0;const key={};const broker=new BrowserBroker(()=>({key,generation:1,producerEpoch:'p',appServerEpoch:'a',supported:true,send:()=>{sends++;return true;}}));
 const result=broker.control(binding,{action:'approve'});broker.disconnect('m',key);await assert.rejects(result,/断开/);assert.equal(sends,1);broker.close();
});
test('old agents are rejected before any command is sent',()=>{
 const broker=new BrowserBroker(()=>({key:{},generation:1,producerEpoch:'p',appServerEpoch:'a',supported:false,send:()=>{throw Error('must not send');}}));
 assert.throws(()=>broker.control(binding,{action:'open'}),/更新/);broker.close();
});

test('state recovery requires explicit capability and never falls back to opening a browser',()=>{
 let sends=0;const broker=new BrowserBroker(()=>({key:{},generation:1,producerEpoch:'p',appServerEpoch:'a',supported:true,send:()=>{sends++;return true;}}));
 assert.throws(()=>broker.control(binding,{action:'status'}),(error:unknown)=>(error as {code:string}).code==='BROWSER_UPDATE_REQUIRED');assert.equal(sends,0);broker.close();
});
test('late open receipt is discarded; a new status request recovers without replaying open',async()=>{
 const requests:Record<string,unknown>[]=[];const key={};const broker=new BrowserBroker(()=>({key,generation:1,producerEpoch:'p',appServerEpoch:'a',supported:true,statusSupported:true,send:value=>{requests.push(value);return true;}}),10);
 const opening=broker.control(binding,{action:'open'});
 await assert.rejects(opening,(error:unknown)=>(error as {code:string}).code==='BROWSER_TIMEOUT');
 broker.receive('m',key,{requestId:String(requests[0]!.requestId),result:{mode:'human'}});
 const recovery=broker.control(binding,{action:'status'});
 broker.receive('m',key,{requestId:String(requests[1]!.requestId),result:{state:'open'}});
 assert.deepEqual(await recovery,{state:'open'});assert.deepEqual(requests.map(r=>(r.input as {action:string}).action),['open','status']);broker.close();
});
