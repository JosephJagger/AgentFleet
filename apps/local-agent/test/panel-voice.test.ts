import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_VOICE_TOOL, PANEL_VOICE_INSTRUCTIONS, PANEL_REALTIME_PROMPT } from '../src/panel-voice-tools.js';
import { PanelVoiceRuntime } from '../src/panel-voice.js';
import { CodexAppServer, type AppServerCallbacks } from '../src/app-server.js';
import type { StateStore } from '../src/store.js';

test('coordinator native notifications and dynamic tool calls are confined to its ephemeral thread', async()=>{
  const events:Record<string,unknown>[]=[];const replies:Record<string,unknown>[]=[];const calls:string[]=[];
  const server=new CodexAppServer({findManagedThread:()=>undefined,findProject:()=>undefined,onEvent:async()=>undefined,onVolatile:(e:{payload:Record<string,unknown>})=>events.push(e.payload),onPanelTool:async()=>{calls.push('tool');return {state:'idle'};}} as unknown as AppServerCallbacks);
  const internal=server as unknown as {request(method:string,params:Record<string,unknown>):Promise<unknown>;handleLine(line:string):Promise<void>;writeLine(value:Record<string,unknown>):Promise<void>};
  let configuration:Record<string,unknown>={};let selectedVoice:unknown;
  internal.request=async(method,params)=>{if(method==='thread/realtime/start')selectedVoice=params.voice;if(method==='config/read')return {config:{mcp_servers:{personal:{command:'node',args:['mcp.js'],tool_timeout_sec:null},'node.repl':{url:'https://example.test/mcp'}}}};if(method==='thread/start'){configuration=params;return {thread:{id:'coordinator'}};}return {};};
  internal.writeLine=async reply=>{replies.push(reply);};
  await server.startPanelVoice('/tmp','pvoice_test','v=0\r\nm=audio 9\r\n','shimmer');
  assert.equal(selectedVoice,'shimmer');
  assert.equal(configuration.ephemeral,true);
  assert.equal(configuration.sandbox,'read-only');
  for(const feature of ['shell_tool','unified_exec','apps','computer_use','hooks','multi_agent','code_mode_host'])assert.equal((configuration.config as Record<string,unknown>)[`features.${feature}`],false);
  assert.deepEqual((configuration.config as Record<string,unknown>).mcp_servers,{personal:{command:'node',enabled:false},'node.repl':{url:'https://example.test/mcp',enabled:false}});
  assert.ok(!Object.keys(configuration.config as object).some(k=>k.startsWith('mcp_servers.')));
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

test('startup configuration failure is reported before cleanup closes the owner',async()=>{
  let state:unknown;const events:Record<string,unknown>[]=[];
  const store={snapshot:()=>({panelVoiceRuntime:state}),setPanelVoiceRuntime:async(value:unknown)=>{state=value;}} as unknown as StateStore;
  const runtime=new PanelVoiceRuntime(store,e=>events.push(e),()=>({start:async()=>undefined,stop:async()=>undefined,getProcessId:()=>123,startPanelVoice:async()=>{throw Error('failed to load configuration: invalid transport SECRET');},reportPanelVoice:async()=>undefined,stopVoice:async()=>undefined}));
  await assert.rejects(runtime.start('pvoice_error','sdp'),/invalid transport/);
  assert.deepEqual(events.map(e=>e.event),['error','stopped']);
  assert.equal(events[0]?.message,'VOICE_CONFIG');assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.equal(state,undefined);await runtime.close();
});

test('native closure disposes the coordinator and allows a new call without waiting for heartbeat expiry',async()=>{
  let state:unknown;let cb!:AppServerCallbacks;let stopped=0;const events:Record<string,unknown>[]=[];
  const store={snapshot:()=>({panelVoiceRuntime:state}),setPanelVoiceRuntime:async(v:unknown)=>{state=v;}} as unknown as StateStore;
  const runtime=new PanelVoiceRuntime(store,e=>events.push(e),callbacks=>{cb=callbacks;return {start:async()=>undefined,stop:async()=>{stopped++;},getProcessId:()=>123,startPanelVoice:async()=>'thread',reportPanelVoice:async()=>undefined,stopVoice:async()=>undefined};});
  await runtime.start('pvoice_first','sdp');
  cb.onVolatile({type:'voice.event',payload:{event:'closed'}} as never,'epoch');
  await new Promise(r=>setTimeout(r,20));
  assert.equal(state,undefined);assert.equal(stopped,1);
  assert.deepEqual(events.map(e=>e.event),['closed','stopped']);
  await runtime.start('pvoice_second','sdp');await runtime.close();
});

test('stop of a rejected start is acknowledged without stopping another call; unknown persisted ownership remains fenced',async()=>{
  let state:unknown;let stops=0;const events:Record<string,unknown>[]=[];
  const store={snapshot:()=>({panelVoiceRuntime:state}),setPanelVoiceRuntime:async(v:unknown)=>{state=v;}} as unknown as StateStore;
  const runtime=new PanelVoiceRuntime(store,e=>events.push(e),()=>({start:async()=>undefined,stop:async()=>{stops++;},getProcessId:()=>123,startPanelVoice:async()=>'thread',reportPanelVoice:async()=>undefined,stopVoice:async()=>undefined}));
  await runtime.start('pvoice_live','sdp');
  await assert.rejects(runtime.start('pvoice_rejected','sdp'),/active/);
  await runtime.stop('pvoice_rejected');assert.equal(stops,0);assert.equal(events.at(-1)?.voiceId,'pvoice_rejected');
  await runtime.stop('pvoice_live');await runtime.stop('pvoice_live');
  assert.equal(events.filter(e=>e.voiceId==='pvoice_live'&&e.event==='stopped').length,2);
  state={voiceId:'pvoice_unknown',pid:999};const n=events.length;
  await runtime.stop('pvoice_unknown');assert.equal(events.length,n);
  await runtime.close();
});

 test('coordinator and realtime instructions allow cross-project concurrency with exact task queries',()=>{
  assert.ok('jobId' in PANEL_VOICE_TOOL.inputSchema.properties);
  assert.match(PANEL_VOICE_INSTRUCTIONS,/Different projects may run concurrently/);
  assert.match(PANEL_VOICE_INSTRUCTIONS,/same project\/session/);
  assert.match(PANEL_VOICE_INSTRUCTIONS,/query jobId/);
  assert.match(PANEL_REALTIME_PROMPT,/Different projects may run concurrently/);
  assert.doesNotMatch(PANEL_VOICE_INSTRUCTIONS+PANEL_REALTIME_PROMPT,/One outstanding task at a time|Only one dispatched/);
 });
