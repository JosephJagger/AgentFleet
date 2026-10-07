import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import type { AppServerCallbacks } from "../src/app-server.js";
import type { ManagedThread, ProjectRecord } from "../src/types.js";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";

const project = { id: "claude-project", root: "/tmp", provider: "claude" } as ProjectRecord;
test("Claude starts the first streaming prompt, resumes the original identity and reports completion", async () => {
  const id = "claude_12345678-1234-1234-1234-123456789012";
  const thread = { nativeThreadId: id, projectId: project.id, sessionCwd: project.root, nativeUsage:{usage:{total:{inputTokens:6,outputTokens:4,cachedInputTokens:1,reasoningOutputTokens:0,totalTokens:10}},occurredAt:new Date().toISOString()} } as unknown as ManagedThread;
  const events: Array<{type: string;payload?:Record<string,unknown>}> = [];
  let options!: Options;
  let resolve!: () => void;
  const completed = new Promise<void>(r => { resolve = r; });
  let closed = false;
  const runtime = new ClaudeRuntime({ findManagedThread: () => thread, findProject: () => project,
    onVolatile: () => {}, onExit: async () => {}, onApprovalResolved: async () => {}, onApproval: async approval => { if (approval.method === "item/tool/requestUserInput") { assert.equal(approval.params.kind,"user_input"); await runtime.respondInput(approval, { "0": { answers: ["Chosen"] } }); } else await runtime.respondApproval(approval,"accept"); }, onEvent: async e => { events.push(e); if (e.type === "turn.completed") resolve(); },
  } as AppServerCallbacks, "epoch", {
    detectClaude: async () => ({ installed: true, version: "test", path: "/bin/claude" }),
    nativeClaudeRunning: async () => false,
    query: ({prompt, options: opts}) => {
      options = opts!;
      return { close: () => { closed = true; }, async *[Symbol.asyncIterator]() {
        const message = await (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
        assert.equal((message.value as {message:{content:Array<{text:string}>}}).message.content[0]?.text, "Continue original context");
        yield { type: "system", subtype: "init", session_id: id.slice(7) };
        const context = { signal: new AbortController().signal, toolUseID: "tool" } as never;
        const approved = await options.canUseTool!("Bash", { command: "echo test" }, context);
        assert.equal(approved?.behavior,"allow");
        const answer = await options.canUseTool!("AskUserQuestion", { questions: [{ question: "Which?", options: [] }] }, context);
        assert.deepEqual(answer, { behavior: "allow", updatedInput: {questions: [{question:"Which?",options:[]}],answers:{"Which?":"Chosen"}} });
        yield { type: "assistant", uuid: "message", message: { id: "native-message", content: [{type:"text",text:"Continued"}] } };
        yield { type: "result", is_error: false, modelUsage: {sonnet:{inputTokens:8,outputTokens:7,cacheCreationInputTokens:0,cacheReadInputTokens:0}}, usage: {input_tokens:2,output_tokens:3} };
      } } as unknown as Query;
    },
  });
  await runtime.start();
  await runtime.startTurn(thread, project, "Continue original context",undefined,{model:"sonnet",effort:"low",mode:"plan"});
  await Promise.race([completed, new Promise((_,reject) => { const t=setTimeout(()=>reject(new Error("first prompt never sent")),1000);t.unref(); })]);
  assert.equal(options.resume, id.slice(7));
  assert.equal(options.pathToClaudeCodeExecutable, "/bin/claude");
  assert.deepEqual(options.settingSources, ["user","project","local"]);
  assert.equal(options.permissionMode,"plan");
  assert.equal(options.model,"sonnet");assert.equal(options.effort,"low");
  assert.deepEqual(events.map(e=>e.type),["item.completed","thread.usage","turn.completed"]);
  const usage=events.find(e=>e.type==="thread.usage")!.payload!.usage as {total:{totalTokens:number};last:{totalTokens:number}};
  assert.equal(usage.total.totalTokens,15);assert.equal(usage.last.totalTokens,5);
  await runtime.stop(); assert.equal(closed,true);
});

test("missing Claude and missing original sessions fail without replacing context", async () => {
  const runtime = new ClaudeRuntime({ findManagedThread: () => undefined } as unknown as AppServerCallbacks,"epoch",{
    detectClaude:async()=>({installed:false,version:null}),getSessionInfo:async()=>undefined,
  });
  await runtime.start();assert.deepEqual(await runtime.listThreads(),[]);
  await assert.rejects(runtime.createThread(project), /未安装/);
  await assert.rejects(runtime.readThread("claude_missing"), /原会话不存在/);
});

test("an active native Claude terminal cannot acquire a second writer", async () => {
  const runtime = new ClaudeRuntime({} as AppServerCallbacks,"epoch",{
    detectClaude:async()=>({installed:true,version:"test",path:"/bin/claude"}),nativeClaudeRunning:async()=>true,
  });
  await runtime.start();await assert.rejects(runtime.resumeThread("claude_original",project),/终端仍在运行/);
});

test("Claude cancellation waits for the native result before reporting interrupted", async () => {
  const id="claude_12345678-1234-1234-1234-123456789012";
  const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
  let finish!:()=>void;const cancelled=new Promise<void>(r=>{finish=r;});
  let terminal!:()=>void;const completed=new Promise<void>(r=>{terminal=r;});
  let status:string|undefined;
  const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{},onEvent:async e=>{if(e.type==="turn.completed"){status=(e.payload.turn as {status:string}).status;terminal();}}} as AppServerCallbacks,"epoch",{
    detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
    query:()=>({close:()=>{},interrupt:async()=>{assert.equal(status,undefined);finish();},async *[Symbol.asyncIterator](){await cancelled;yield {type:"result",is_error:false,modelUsage:{},usage:{input_tokens:0,output_tokens:0}};}} as unknown as Query),
  });
  await runtime.start();const turn=await runtime.startTurn(thread,project,"Work");
  await runtime.interruptTurn(id,turn.nativeTurnId!);await completed;
  assert.equal(status,"interrupted");await runtime.stop();
});
test("Claude history preserves the SDK conversation chain and exposes stable item order", async()=>{
 const runtime=new ClaudeRuntime({} as AppServerCallbacks,"epoch",{
   getSessionInfo:async()=>({sessionId:"original",summary:"",cwd:"/tmp",lastModified:0}),
   getSessionMessages:async()=>[
     {type:"user",uuid:"u",session_id:"original",parent_tool_use_id:null,parent_agent_id:null,message:{content:"429?"}},
     {type:"assistant",uuid:"a",session_id:"original",parent_tool_use_id:null,parent_agent_id:null,message:{id:"reply",content:[{type:"text",text:"answer"}]}},
   ],
 });
 const page=await runtime.readHistoryPage("claude_original",null);
 assert.deepEqual(page.order,[{itemId:"u:text",index:0},{itemId:"reply:text",index:100}]);
 assert.equal(page.items[0]?.item?.type,"userMessage");assert.equal(page.nextCursor,null);
});

test("Claude native permission modes reach the SDK and plan mode takes precedence",async()=>{
 const {parseClaudeSettings}=await import("../src/claude-settings.js");
 const id="claude_12345678-1234-1234-1234-123456789012";
 const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const options:Options[]=[];
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onDurable:async()=>{},onExit:async()=>{}} as unknown as AppServerCallbacks,"epoch",{
   detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
   inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
   query:input=>{options.push(input.options!);return {close(){},async *[Symbol.asyncIterator](){yield {type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:0,output_tokens:0},modelUsage:{}};}} as unknown as Query;},
 });
 await runtime.start();
 for(const mode of ["auto","acceptEdits","dontAsk"]){await runtime.startTurn(thread,project,"test",undefined,parseClaudeSettings({model:"host",permissionMode:mode}));await new Promise(resolve=>setImmediate(resolve));await runtime.unsubscribeThread(id);}
 assert.deepEqual(options.map(o=>o.permissionMode),["auto","acceptEdits","dontAsk"]);
 await runtime.startTurn(thread,project,"plan",undefined,parseClaudeSettings({model:"host",permissionMode:"auto",mode:"plan"}));await new Promise(resolve=>setImmediate(resolve));assert.equal(options.at(-1)?.permissionMode,"plan");
 assert.throws(()=>parseClaudeSettings({model:"host",permissionMode:"bypassPermissions"}),/Unsupported/);
 await runtime.stop();
});

test("resumed background results cannot complete or discard a newly submitted Claude prompt", async () => {
 const id="claude_12345678-1234-1234-1234-123456789012";
 const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const events:Array<{type:string;nativeTurnId?:string;payload:Record<string,unknown>}>=[];
 let terminal!:()=>void;
 let closed=0,calls=0;
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{},onEvent:async e=>{
   events.push(e);
   if(e.type==="turn.completed"){await runtime.unsubscribeThread(id);terminal();}
 }} as AppServerCallbacks,"epoch",{
   detectClaude:async()=>({installed:true,version:"2.1.285 (Claude Code)",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
   inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
   query:({prompt})=>({close:()=>{closed++;},async *[Symbol.asyncIterator](){
     const call=++calls;
     const sent=await (prompt as AsyncIterable<{uuid:string}>)[Symbol.asyncIterator]().next();
     const result={type:"result",is_error:false,num_turns:1,modelUsage:{},usage:{input_tokens:0,output_tokens:0}};
     // Synthetic restoration notification, then another prompt's result.
     yield {...result,num_turns:0,queued_turn_count:1};
     assert.equal(closed,call-1,"queued prompt must remain alive after a synthetic result");
     yield {...result,user_message_uuid:"previous-prompt",queued_turn_count:1};
     assert.equal(closed,call-1,"another prompt's result must not release this writer");
     // Even a nonzero synthetic turn with no echo is not our send.
     yield {...result,queued_turn_count:0};
     assert.equal(closed,call-1);
     yield {type:"assistant",uuid:`reply-${call}`,message:{id:`reply-${call}`,content:[{type:"text",text:"Executed once"}]}};
     yield {...result,user_message_uuid:call===1?sent.value!.uuid:"merged-later-prompt",user_message_uuids:[sent.value!.uuid,"merged-later-prompt"]};
   }} as unknown as Query),
 });
 await runtime.start();
 for(let n=0;n<2;n++){
   const done=new Promise<void>(resolve=>{terminal=resolve;});
   const turn=await runtime.startTurn(thread,project,`Task ${n}`);
   await done;
   assert.equal(events.filter(e=>e.type==="turn.completed" && e.nativeTurnId===turn.nativeTurnId).length,1);
 }
 assert.equal(calls,2);assert.equal(closed,2);
 assert.equal(events.filter(e=>e.type==="thread.usage").length,2);
 assert.equal(events.filter(e=>e.type==="item.completed").length,2);
 assert.equal(events.some(e=>e.type==="turn.error"),false);
 await runtime.stop();
});

test("unattributed Claude startup failure is reported instead of waiting for a matching prompt forever",async()=>{
 const id="claude_12345678-1234-1234-1234-123456789012";
 const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const events:Array<{type:string;payload:Record<string,unknown>}>=[];
 let finish!:()=>void;const completed=new Promise<void>(r=>{finish=r;});
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{},onEvent:async e=>{events.push(e);if(e.type==="turn.completed")finish();}} as AppServerCallbacks,"epoch",{
  detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
  query:()=>({close(){},async *[Symbol.asyncIterator](){yield {type:"result",is_error:true,num_turns:0,errors:["Native startup failed"],modelUsage:{},usage:{input_tokens:0,output_tokens:0}};}} as unknown as Query),
 });
 await runtime.start();await runtime.startTurn(thread,project,"Work");await completed;
 assert.equal(events.find(e=>e.type==="turn.error")?.payload.message,"Native startup failed");
 assert.equal((events.find(e=>e.type==="turn.completed")?.payload.turn as {status:string}).status,"failed");
 await runtime.stop();
});

test("panel-created Claude titles reach the native session and survive AI title discovery",async()=>{
 let options:Options|undefined;
 let thread:ManagedThread|undefined;
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread} as unknown as AppServerCallbacks,"epoch",{
  detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
  listSessions:async()=>[{sessionId:thread!.nativeThreadId.slice(7),cwd:project.root,summary:"Auto-generated summary",customTitle:"Auto-generated summary",lastModified:0}],
  query:input=>{options=input.options;return {close(){},async *[Symbol.asyncIterator](){}} as unknown as Query;},
 });
 await runtime.start();const created=await runtime.createThread(project);
 thread={nativeThreadId:created.nativeThreadId,projectId:project.id,sessionCwd:project.root,origin:"agentfleet",title:"我的项目计划",titleSource:"name"} as ManagedThread;
 await runtime.startTurn(thread,project,"First task");
 assert.equal(options?.title,"我的项目计划");
 const [listed]=await runtime.listThreads();assert.equal(listed?.title,"我的项目计划");assert.equal(listed?.titleSource,"name");
 await runtime.stop();
 // Imported native sessions retain native title discovery.
 thread.origin="host_claimed";
 assert.equal((await runtime.listThreads())[0]?.title,"Auto-generated summary");
});
