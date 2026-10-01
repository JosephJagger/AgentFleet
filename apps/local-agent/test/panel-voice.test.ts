import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelVoiceRuntime } from '../src/panel-voice.js';
import { CodexAppServer, type AppServerCallbacks } from '../src/app-server.js';
import type { StateStore } from '../src/store.js';

test('coordinator native notifications and dynamic tool calls are confined to its ephemeral thread', async()=>{
  const events:Record<string,unknown>[]=[];const replies:Record<string,unknown>[]=[];const calls:string[]=[];
  const server=new CodexAppServer({findManagedThread:()=>undefined,findProject:()=>undefined,onEvent:async()=>undefined,onVolatile:(e:{payload:Record<string,unknown>})=>events.push(e.payload),onPanelTool:async()=>{calls.push('tool');return {state:'idle'};}} as unknown as AppServerCallbacks);
  const internal=server as unknown as {request(method:string,params:Record<string,unknown>):Promise<unknown>;handleLine(line:string):Promise<void>;writeLine(value:Record<string,unknown>):Promise<void>};
  let configuration:Record<string,unknown>={};
  internal.request=async(method,params)=>{if(method==='config/read')return {config:{mcp_servers:{personal:{}}}};if(method==='thread/start'){configuration=params;return {thread:{id:'coordinator'}};}return {};};
  internal.writeLine=async reply=>{replies.push(reply);};
  await server.startPanelVoice('/tmp','pvoice_test','v=0\r\nm=audio 9\r\n');
  assert.equal(configuration.ephemeral,true);
  assert.equal(configuration.sandbox,'read-only');
  assert.equal((configuration.config as Record<string,unknown>)['mcp_servers."personal".enabled'],false);
  await internal.handleLine(JSON.stringify({method:'thread/realtime/sdp',params:{threadId:'coordinator',sdp:'v=0\r\n'}}));
  assert.equal(events[0]?.event,'sdp');
  await internal.handleLine(JSON.stringify({method:'item/tool/call',id:1,params:{threadId:'coordinator',tool:'agentfleets_panel',arguments:{action:'status'}}}));
  await internal.handleLine(JSON.stringify({method:'item/tool/call',id:2,params:{threadId:'foreign',tool:'agentfleets_panel',arguments:{action:'status'}}}));
  assert.equal(calls.length,1);assert.equal((replies[1]?.result as {success:boolean}).success,false);
});

test('hangup during startup waits for cleanup, rejects overlapping calls, and does not start realtime afterward',async()=>{
  let state:unknown;let release!:()=>void;let stops=0;let realtime=0;
  const gate=new Promise<void>(r=>{release=r;});
  const store={snapshot:()=>({panelVoiceRuntime:state}),setPanelVoiceRuntime:async(value:unknown)=>{state=value;}} as unknown as StateStore;
  const runtime=new PanelVoiceRuntime(store,()=>undefined,()=>({start:()=>gate,stop:async()=>{stops++;},getProcessId:()=>123,startPanelVoice:async()=>{realtime++;return 'thread';},reportPanelVoice:async()=>undefined,stopVoice:async()=>undefined}));
  const start=runtime.start('pvoice_a','sdp');
  await new Promise(r=>setTimeout(r,10));
  const stop=runtime.stop('pvoice_a');
  await assert.rejects(runtime.start('pvoice_b','sdp'),/awaiting cleanup/);
  release();await start;await stop;
  assert.equal(realtime,0);assert.equal(stops,1);assert.equal(state,undefined);
  await runtime.close();
});

test('duplicate delivery acknowledgments append a completion report only once',async()=>{
  let state:unknown;let reports=0;const events:Record<string,unknown>[]=[];
  const store={snapshot:()=>({panelVoiceRuntime:state}),setPanelVoiceRuntime:async(value:unknown)=>{state=value;}} as unknown as StateStore;
  const runtime=new PanelVoiceRuntime(store,e=>events.push(e),()=>({start:async()=>undefined,stop:async()=>undefined,getProcessId:()=>123,startPanelVoice:async()=>'thread',reportPanelVoice:async()=>{reports++;},stopVoice:async()=>undefined}));
  await runtime.start('pvoice_a','sdp');
  await Promise.all([runtime.report('pvoice_a','done','job'),runtime.report('pvoice_a','done','job')]);
  assert.equal(reports,1);assert.equal(events.filter(e=>e.event==='reported').length,2);
  await runtime.close();await assert.rejects(runtime.report('pvoice_a','late','job'),/Call ended/);
});
