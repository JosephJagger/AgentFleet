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
