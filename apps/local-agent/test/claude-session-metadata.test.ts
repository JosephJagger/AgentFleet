import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import {ClaudeRuntime} from "../src/claude-runtime.js";
import type {AppServerCallbacks} from "../src/app-server.js";
import type {ProjectRecord} from "../src/types.js";

test("real SDK resumes a bound Claude session whose large first prompt hides cwd from unscoped metadata", async t => {
 const root=await mkdtemp(join(tmpdir(),"claude-cwd-window-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const cwd=join(root,"project"), config=join(root,"config"), id="12345678-1234-4234-8234-123456789012";
 const directory=join(config,"projects",cwd.replace(/[^a-zA-Z0-9]/g,"-"));await mkdir(directory,{recursive:true});await mkdir(cwd);
 await writeFile(join(directory,`${id}.jsonl`),[
  {type:"custom-title",sessionId:id,customTitle:"Large first prompt"},
  {type:"user",uuid:"11111111-1111-4111-8111-111111111111",parentUuid:null,isSidechain:false,message:{role:"user",content:"context ".repeat(30000)},timestamp:new Date().toISOString(),cwd,sessionId:id},
 ].map(x=>JSON.stringify(x)).join("\n")+"\n");
 const script=`
  import {getSessionInfo,listSessions} from '@anthropic-ai/claude-agent-sdk';
  import {ClaudeRuntime} from ${JSON.stringify(new URL("../src/claude-runtime.js",import.meta.url).href)};
  const id=process.env.TEST_ID,cwd=process.env.TEST_CWD,thread={nativeThreadId:'claude_'+id,projectId:'p',sessionCwd:cwd};
  const project={id:'p',root:cwd,provider:'claude'};
  const runtime=new ClaudeRuntime({findManagedThread:key=>key===thread.nativeThreadId?thread:undefined,findProject:()=>project},'e',{
   detectClaude:async()=>({installed:true,version:'2.1.296',path:'/fixture/claude'}),nativeClaudeRunning:async()=>false,
   inspectClaudeMetadata:async()=>({models:[]}),
   listSessions:async()=>[await getSessionInfo(id)],
  });
  const unscoped=await getSessionInfo(id);
  await runtime.start();const resumed=await runtime.resumeThread(thread.nativeThreadId,project,cwd);
  const listed=await runtime.listThreads();await runtime.stop();
  console.log(JSON.stringify({missingUnscopedCwd:!unscoped?.cwd,resumed:resumed.history.cwd,listed:listed.map(t=>t.cwd)}));
 `;
 const {stdout}=await promisify(execFile)(process.execPath,["--input-type=module","-e",script],{cwd:new URL("../../",import.meta.url),env:{...process.env,CLAUDE_CONFIG_DIR:config,TEST_ID:id,TEST_CWD:cwd}});
 assert.deepEqual(JSON.parse(stdout),{missingUnscopedCwd:true,resumed:cwd,listed:[cwd]});
});

test("scoped metadata never substitutes a missing original or accepts another cwd",async()=>{
 const project={id:"p",root:"/expected",provider:"claude"} as ProjectRecord;
 let missing=true,queries=0;
 const runtime=new ClaudeRuntime({findManagedThread:()=>({projectId:"p",sessionCwd:"/expected"}),findProject:()=>project} as unknown as AppServerCallbacks,"e",{
  detectClaude:async()=>({installed:true,version:"2.1.296",path:"/fixture/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,windows:[],observedAt:new Date().toISOString(),subscriptionType:null}}),
  getSessionInfo:async(id,options)=>{assert.equal(options?.dir,"/expected");return missing?undefined:{sessionId:id,cwd:"/other",summary:"existing",lastModified:0};},
  query:()=>{queries++;throw Error("must not send");},
 });
 await runtime.start();await assert.rejects(runtime.resumeThread("claude_original",project),{code:"CLAUDE_SESSION_MISSING"});
 missing=false;await assert.rejects(runtime.resumeThread("claude_original",project),{code:"THREAD_CWD_MISMATCH"});assert.equal(queries,0);await runtime.stop();
});
