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
    detectClaude:async()=>({installed:true,version:"test",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
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
