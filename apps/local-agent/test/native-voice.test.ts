import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/projects.js";
import { turnPermissionPolicy } from "../src/permissions.js";
import test from "node:test";
import assert from "node:assert/strict";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";
import type { ManagedThread } from "../src/types.js";

test("native stop waits for closed and ordered backing-task events, not just the RPC response",async()=>{
  const thread={nativeThreadId:"native",realtimeSessionId:"voice_fixture",appServerEpoch:"epoch",policyVerified:true} as ManagedThread;
  const requests:{method:string;params:Record<string,unknown>}[]=[];
  const events:string[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const server=new CodexAppServer({findManagedThread:()=>thread,findProject:()=>undefined,onApproval:async()=>undefined,onApprovalResolved:async()=>undefined,onExit:async()=>undefined,onCatalogChanged:()=>undefined,
    onEvent:async event=>{await gate;events.push(event.type);},onVolatile:event=>{events.push(String(event.payload.event));},
  } as AppServerCallbacks,"epoch");
  const internal=server as unknown as {request(method:string,params:Record<string,unknown>):Promise<unknown>;handleLine(line:string):Promise<void>};
  internal.request=async(method,params)=>{requests.push({method,params});return {};};
  await server.startVoice(thread,"v=0\r\nm=audio 9\r\n");
  await internal.handleLine(JSON.stringify({method:"thread/realtime/itemAdded",params:{threadId:"native",item:{type:"handoff_request"}}}));
  assert.deepEqual(events,["task"]); events.length=0;
  assert.equal(requests[0]?.params.version,"v3");
  assert.equal(requests[0]?.params.voice,"sol");
  assert.equal(requests[0]?.params.realtimeSessionId,thread.realtimeSessionId);
  assert.match(String(requests[0]?.params.prompt),/verbal promise is not execution/);
  assert.equal(requests[0]?.params.flushTranscriptTailOnSessionEnd,false);
  let stopped=false;const stop=server.stopVoice("native").then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  const started=internal.handleLine(JSON.stringify({method:"turn/started",params:{threadId:"native",turn:{id:"backing-turn"}}}));
  const closed=internal.handleLine(JSON.stringify({method:"thread/realtime/closed",params:{threadId:"native"}}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  release();await Promise.all([started,closed,stop]);
  assert.deepEqual(events,["turn.started","task","closed"]);assert.equal(stopped,true);
  await server.stopVoice("native");assert.equal(requests.filter(r=>r.method==="thread/realtime/stop").length,1);
});


test("voice resume merges realtime and goal flags with the verified permission configuration",async t=>{
  const root=await mkdtemp(join(tmpdir(),"agentfleet-voice-resume-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=await resolveProject(root,"voice-fixture");
  const server=new CodexAppServer({} as AppServerCallbacks,"epoch");
  const internal=server as unknown as {initialized:boolean;child:unknown;request(method:string,params:Record<string,unknown>):Promise<unknown>};
  internal.initialized=true;internal.child={};
  server.readThread=async()=>({nativeThreadId:"native",cwd:root,historyMode:"legacy",executionState:"idle",items:[],updatedAt:null});
  let args:Record<string,unknown>|undefined;
  internal.request=async(_method,params)=>{args=params;return {cwd:root,approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:turnPermissionPolicy(root,"project"),thread:{id:"native",cwd:root,turns:[]}};};
  const result=await server.resumeThread("native",project,root,"project",true,true);
  const config=args?.config as Record<string,unknown>;
  assert.equal(config['features.realtime_conversation'],true);
  assert.equal(config['features.goals'],false);
  assert.equal(config.sandbox_mode,"workspace-write");
  assert.equal(result.policyVerified,true);
});

import { voiceErrorCode } from "../src/voice-errors.js";
test("voice diagnostics expose only fixed codes, never native credentials or URLs",()=>{
  assert.equal(voiceErrorCode("failed sideband: HTTP 403 bearer secret"),"VOICE_HTTP_403");
  assert.equal(voiceErrorCode("SDP codec unsupported https://private/?token=secret"),"VOICE_SDP");
  assert.equal(voiceErrorCode("sensitive unknown body"),"VOICE_NATIVE_ERROR");
});

test("selected voice reaches the native realtime request and invalid voices never start", async () => {
  const server = new CodexAppServer({} as AppServerCallbacks);
  const requests: {method:string;params:Record<string,unknown>}[] = [];
  (server as unknown as {request(method:string,params:Record<string,unknown>):Promise<unknown>}).request = async (method,params) => { requests.push({method,params}); return {}; };
  const thread = {nativeThreadId:"voice-choice",realtimeSessionId:"voice_choice"} as ManagedThread;
  await assert.rejects(server.startVoice(thread,"sdp","invalid"),/Unsupported native voice/);
  assert.equal(requests.length,0);
  await server.startVoice(thread,"sdp","coral");
  assert.equal(requests[0]?.params.voice,"coral");
});

import { supportsNativeVoice } from "../src/voice-options.js";
test("reviewed 0.160.1 retains native voice while unknown versions remain gated",()=>{
 assert.equal(supportsNativeVoice("0.160.1"),true);
 assert.equal(supportsNativeVoice("0.159.2"),true);
 assert.equal(supportsNativeVoice("0.159.0"),false);
 assert.equal(supportsNativeVoice("0.161.0"),false);
 assert.equal(supportsNativeVoice(undefined),false);
});

test('voice starts with only explicit preference snapshot; updates use developer role, deduplicate and never start tasks',async()=>{
 const thread={nativeThreadId:'pref-thread',realtimeSessionId:'voice_pref'} as ManagedThread;
 const server=new CodexAppServer({} as AppServerCallbacks,'epoch');
 const requests:{method:string;params:Record<string,unknown>}[]=[];
 const internal=server as unknown as {request(method:string,params:Record<string,unknown>):Promise<unknown>};
 internal.request=async(method,params)=>{requests.push({method,params});return {};};
 const snapshot=JSON.stringify([{id:'english',body:'Correct English before responding. Ask when unclear.',conditions:'When the user speaks English'}]);
 await server.startVoice(thread,'v=0\r\nm=audio 9\r\n','sol',snapshot);
 assert.equal(requests[0]!.params.includeStartupContext,false);
 assert.match(String(requests[0]!.params.prompt),/Correct English before responding/);
 await server.updateVoicePreferences('pref-thread','[]','revision-2');
 await server.updateVoicePreferences('pref-thread','[]','revision-2');
 assert.equal(requests.length,2);assert.equal(requests[1]!.method,'thread/realtime/appendText');assert.equal(requests[1]!.params.role,'developer');
 assert.match(String(requests[1]!.params.text),/empty list means no saved rules/);
 await assert.rejects(server.updateVoicePreferences('different','[]','revision-2'),/Voice ended/);
 assert.equal(requests.some(r=>r.method==='turn/start'),false);
});
