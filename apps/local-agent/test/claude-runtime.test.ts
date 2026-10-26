import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import { sshAccess } from "../src/ssh-access.js";
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
      return { close: () => { closed = true; }, setPermissionMode: async (mode: string) => { assert.equal(mode, "plan"); }, async *[Symbol.asyncIterator]() {
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
  assert.equal(options.permissionMode,"default");
  assert.equal(options.model,"sonnet");assert.equal(options.effort,"low");
  assert.deepEqual(events.map(e=>e.type),["item.completed","item.completed","thread.usage","turn.completed"]);
  assert.equal((events[0]!.payload!.item as {type:string}).type,"userMessage");
  assert.deepEqual((events[0]!.payload!.item as {content:unknown}).content,[{type:"text",text:"Continue original context"}]);
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

test("Claude native permission modes reach the SDK and plan is entered before sending",async()=>{
 const {parseClaudeSettings}=await import("../src/claude-settings.js");
 const id="claude_12345678-1234-1234-1234-123456789012";
 const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const options:Options[]=[];
 const switches:string[]=[];
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onDurable:async()=>{},onExit:async()=>{}} as unknown as AppServerCallbacks,"epoch",{
   detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
   inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
   query:input=>{options.push(input.options!);return {close(){},async setPermissionMode(mode:string){switches.push(mode);},async *[Symbol.asyncIterator](){yield {type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:0,output_tokens:0},modelUsage:{}};}} as unknown as Query;},
 });
 await runtime.start();
 for(const mode of ["auto","acceptEdits","dontAsk"]){await runtime.startTurn(thread,project,"test",undefined,parseClaudeSettings({model:"host",permissionMode:mode}));await new Promise(resolve=>setImmediate(resolve));await runtime.unsubscribeThread(id);}
 assert.deepEqual(options.map(o=>o.permissionMode),["auto","acceptEdits","dontAsk"]);
 await runtime.startTurn(thread,project,"plan",undefined,parseClaudeSettings({model:"host",permissionMode:"auto",mode:"plan"}));await new Promise(resolve=>setImmediate(resolve));assert.equal(options.at(-1)?.permissionMode,"auto");assert.deepEqual(switches,["plan"]);
 assert.throws(()=>parseClaudeSettings({model:"host",permissionMode:"bypassPermissions"}),/Unsupported/);
 await runtime.stop();
});

test("first and resumed Claude plan exits restore only the turn's chosen execution permissions", async () => {
 for (const fresh of [true, false]) for (const permissionMode of ["auto", "acceptEdits", "default", "dontAsk"] as const) {
  const {parseClaudeSettings}=await import("../src/claude-settings.js");
  let options!:Options, input!:AsyncIterable<unknown>;
  let finishPlan!:()=>void;
  const planReady=new Promise<void>(resolve=>{finishPlan=resolve;});
  const approvals:import("../src/types.js").ApprovalRecord[]=[];
  let consumed=0;
  const runtime=new ClaudeRuntime({
   findManagedThread:()=>undefined,findProject:()=>project,onVolatile:()=>{},onExit:async()=>{},
   onEvent:async e=>{if(e.type==="item.completed")consumed++;},onApprovalResolved:async()=>{},
   onApproval:async a=>{approvals.push(a);},
  } as AppServerCallbacks,"epoch",{
   detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),
   nativeClaudeRunning:async()=>false,
   inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
   query:args=>{
    options=args.options!;input=args.prompt as AsyncIterable<unknown>;
    return {close(){},async setPermissionMode(mode:string){assert.equal(mode,"plan");await planReady;},async *[Symbol.asyncIterator](){}} as unknown as Query;
   },
  });
  await runtime.start();
  const id=fresh?(await runtime.createThread(project)).nativeThreadId:"claude_12345678-1234-1234-1234-123456789012";
  const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
  const starting=runtime.startTurn(thread,project,"Implement after approval",undefined,parseClaudeSettings({model:"host",mode:"plan",permissionMode}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(options.permissionMode,permissionMode);
  assert.equal(fresh?options.sessionId:options.resume,id.slice(7));
  const iterator=input[Symbol.asyncIterator]();
  const first=iterator.next();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(consumed,0,"no prompt may run in execution mode before plan initialization succeeds");
  finishPlan();await starting;await first;
  assert.equal(consumed,1);
  const context={signal:new AbortController().signal,toolUseID:"exit",decisionReason:"Plan approval is required",
   suggestions:[{type:"setMode",mode:"bypassPermissions",destination:"userSettings"}]} as Parameters<NonNullable<Options["canUseTool"]>>[2];
  for (const decision of ["decline","cancel","accept"] as const) {
   const result=options.canUseTool!("ExitPlanMode",{plan:"A plan"},context);
   const approval=approvals.at(-1)!;
   assert.equal(approval.params.reason,context.decisionReason);
   assert.equal(approval.params.executionPermissionMode,permissionMode);
   await runtime.respondApproval(approval,decision);
   assert.deepEqual(await result,decision==="accept"
    ?{behavior:"allow",updatedInput:{plan:"A plan"},updatedPermissions:[{type:"setMode",mode:permissionMode,destination:"session"}]}
    :{behavior:"deny",message:"用户拒绝执行",interrupt:decision==="cancel"});
  }
  const tool=options.canUseTool!("Bash",{command:"npm test"},context);
  await runtime.respondApproval(approvals.at(-1)!,"accept");
  assert.deepEqual(await tool,{behavior:"allow",updatedInput:{command:"npm test"}},"ordinary approval must not change permissions");
  const controller=new AbortController();
  const aborted=options.canUseTool!("ExitPlanMode",{plan:"A plan"},{...context,signal:controller.signal});
  const expired=approvals.at(-1)!;controller.abort();
  assert.equal((await aborted)?.behavior,"deny");
  await assert.rejects(runtime.respondApproval(expired,"accept"),/失效/);
  await runtime.stop();
 }
});

test("Claude plan initialization failure closes its writer without consuming or dispatching the task", async () => {
 let closed=0,consumed=0;
 const runtime=new ClaudeRuntime({
  findManagedThread:()=>undefined,findProject:()=>project,onVolatile:()=>{},onExit:async()=>{},
  onEvent:async()=>{consumed++;},onApprovalResolved:async()=>{},onApproval:async()=>{},
 } as AppServerCallbacks,"epoch",{
  detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
  query:()=>({close(){closed++;},async setPermissionMode(){throw new Error("native plan refused");},async *[Symbol.asyncIterator](){}} as unknown as Query),
 });
 await runtime.start();
 const thread={nativeThreadId:"claude_12345678-1234-1234-1234-123456789012",projectId:project.id,sessionCwd:project.root} as ManagedThread;
 for(let i=0;i<2;i++)await assert.rejects(runtime.startTurn(thread,project,"Do not send",undefined,{model:"host",mode:"plan"}),/native plan refused/);
 assert.equal(closed,2);assert.equal(consumed,0);
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
 assert.equal(events.filter(e=>e.type==="item.completed").length,4);
 assert.equal(events.some(e=>e.type==="turn.error"),false);
 await runtime.stop();
});

for (const source of ["edges", "snapshot", "queued-notification"] as const) test(`Claude waits for background planning and parent synthesis (${source}), without resending`, async t => {
 const id="claude_parent",thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const events:Array<{type:string;payload:Record<string,unknown>}>=[];
 let done!:()=>void;const completed=new Promise<void>(r=>{done=r;});
 let queries=0,closed=0;
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onExit:async()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onEvent:async e=>{
  events.push(e);if(e.type==="turn.completed"){await runtime.unsubscribeThread(id);done();}
 }} as AppServerCallbacks,"epoch",{
  detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
  query:({prompt})=>{queries++;return {close(){closed++;},async setPermissionMode(mode:string){assert.equal(mode,"plan");},async *[Symbol.asyncIterator](){
   const sent=await (prompt as AsyncIterable<{uuid:string}>)[Symbol.asyncIterator]().next();
   const result={type:"result",is_error:false,num_turns:1,modelUsage:{},usage:{input_tokens:0,output_tokens:0}};
   const task={task_id:"child",task_type:"local_agent",description:"Explore"};
   yield source==="edges"?{type:"system",subtype:"task_started",session_id:"parent",...task}:{type:"system",subtype:"background_tasks_changed",session_id:"parent",tasks:[task]};
   if(source==="queued-notification")yield {type:"system",subtype:"background_tasks_changed",session_id:"parent",tasks:[]};
   yield {...result,user_message_uuid:sent.value!.uuid,...(source==="queued-notification"?{queued_turn_count:1}:{})};
   assert.equal(closed,0,"first parent result must not close active background work");
   assert.equal(events.some(e=>e.type==="turn.completed"),false);
   yield {...result,user_message_uuid:"another-prompt"};
   yield {...result,num_turns:0};
   assert.equal(closed,0,"unrelated and metadata results cannot finish the task");
   if(source!=="edges") {
    yield {type:"system",subtype:"background_tasks_changed",session_id:"parent",tasks:[{task_id:"watcher",task_type:"local_agent",ambient:true}]};
    // SDK explicitly permits late edges after its authoritative level signal.
    yield {type:"system",subtype:"task_started",session_id:"parent",...task};
   } else yield {type:"system",subtype:"task_notification",session_id:"parent",task_id:"child",status:"completed"};
   assert.equal(closed,0,"child completion alone is not parent completion");
   yield {type:"assistant",message:{id:"synthesis",content:[{type:"text",text:"Final plan"}]}};
   yield result;
  }} as unknown as Query;},
 });
 t.after(()=>runtime.stop());await runtime.start();await runtime.startTurn(thread,project,"Plan only",undefined,{model:"host",mode:"plan"});await completed;
 assert.equal(queries,1);assert.equal(closed,1);
 assert.equal(events.filter(e=>e.type==="turn.completed").length,1);
 assert.equal((events.find(e=>e.type==="turn.completed")!.payload.turn as {status:string}).status,"completed");
 assert.equal(events.filter(e=>e.type==="item.completed"&&(e.payload.item as {type:string}).type==="userMessage").length,1);
 assert.ok(JSON.stringify(events).includes("Final plan"));
});

for (const terminal of ["completed", "interrupted"] as const) test(`Claude authoritative idle releases a held background turn (${terminal})`, async t => {
 const id="claude_parent",thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const events:Array<{type:string;payload:Record<string,unknown>}>=[];
 let closed=0,queries=0,activeTurnId="";
 let finish!:()=>void;
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onExit:async()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onEvent:async e=>{
  events.push(e);if(e.type==="turn.completed"){await runtime.unsubscribeThread(id);finish();}
 }} as AppServerCallbacks,"epoch",{
  detectClaude:async()=>({installed:true,version:"2.1.285",path:"/bin/claude"}),nativeClaudeRunning:async()=>false,
  inspectClaudeMetadata:async()=>({models:[],quota:{available:false,observedAt:new Date().toISOString(),subscriptionType:null,windows:[]}}),
  query:({prompt})=>{const previousClosed=closed;queries++;return {close(){closed++;},async interrupt(){},async *[Symbol.asyncIterator](){
   const input=(prompt as AsyncIterable<{uuid:string}>)[Symbol.asyncIterator]();
   const sent=await input.next();
   const state=(state:string,session_id="parent")=>({type:"system",subtype:"session_state_changed",session_id,state});
   yield state("idle"); // Restored session idle is not acknowledgement of our input.
   assert.equal(closed,previousClosed);
   yield {type:"system",subtype:"background_tasks_changed",session_id:"parent",tasks:[{task_id:"child",task_type:"local_agent"}]};
   yield {type:"result",is_error:false,num_turns:1,user_message_uuid:sent.value!.uuid,modelUsage:{},usage:{input_tokens:0,output_tokens:0}};
   yield state("running");yield state("requires_action");yield state("idle","another-session");
   yield {...state("idle"),parent_tool_use_id:"child-tool"};
   assert.equal(closed,previousClosed,"child/foreign states and approval waits must not finish the parent");
   // New user input accepted while waiting must survive an idle for the prior input.
   await runtime.steerTurn(thread,activeTurnId,"Follow up");
   yield state("idle");assert.equal(closed,previousClosed,"unacknowledged follow-up must not be discarded");
   const followup=await input.next();
   yield {type:"result",is_error:false,num_turns:1,user_message_uuid:followup.value!.uuid,modelUsage:{},usage:{input_tokens:0,output_tokens:0}};
   if(terminal==="interrupted")await runtime.interruptTurn(id,activeTurnId);
   // Native idle follows held-result flush and background-loop exit. A stale
   // snapshot must not wedge the turn, and no extra parent result is required.
   yield state("idle");
   assert.fail("idle should finish this query without reading another result");
  }} as unknown as Query;},
 });
 t.after(()=>runtime.stop());await runtime.start();
 for(let i=0;i<2;i++){
  const completed=new Promise<void>(r=>{finish=r;});
  activeTurnId=(await runtime.startTurn(thread,project,`Plan ${i}`)).nativeTurnId;
  await completed;
 }
 assert.equal(queries,2);assert.equal(closed,2);
 assert.equal(events.filter(e=>e.type==="turn.completed").length,2);
 assert.equal((events.find(e=>e.type==="turn.completed")!.payload.turn as {status:string}).status,terminal);
 assert.equal(events.some(e=>e.type==="turn.error"),false);
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

test("Claude native children are SDK-scoped to the verified parent project and long replies are complete", async () => {
  const id = "claude_parent", requests: string[] = [], long = "x".repeat(61000);
  let cwd = "/tmp";
  const runtime = new ClaudeRuntime({} as AppServerCallbacks, "epoch", {
    getSessionInfo: async (parent, options) => { assert.equal(parent, "parent"); assert.equal(options?.dir, "/tmp"); return { sessionId: "parent", cwd, summary: "", lastModified: 0 }; },
    listSubagents: async (parent, options) => { assert.equal(parent, "parent"); assert.equal(options?.dir, "/tmp"); return ["child"]; },
    getSubagentMessages: async (parent, child, options) => {
      assert.equal(parent, "parent"); assert.equal(options?.dir, "/tmp"); requests.push(child);
      return [{ type: "assistant", uuid: "a", session_id: "parent", parent_tool_use_id: "tool", parent_agent_id: null, message: { id: "answer", content: [{ type: "text", text: long }] } }];
    },
  });
  cwd = "/other"; await assert.rejects(runtime.readNativeSubagents(id, project, "/tmp"), { code: "SUBAGENTS_TARGET_CHANGED" });
  cwd = "/tmp"; await assert.rejects(runtime.readNativeSubagents(id, project, "/tmp", "foreign"), { code: "SUBAGENTS_TARGET_CHANGED" });
  assert.deepEqual(requests, []);
  const list = await runtime.readNativeSubagents(id, project, "/tmp");
  assert.equal(list.items[0]?.id, "child"); assert.equal(list.items[0]?.status, "unknown", "persisted text does not prove completion");
  let cursor: string | null = null, text = "", pages = 0;
  do { const page = await runtime.readNativeSubagents(id, project, "/tmp", "child", cursor); text += page.messages!.map(message => message.text).join(""); cursor = page.nextCursor; assert.ok(++pages < 5); } while (cursor);
  assert.equal(text, long);
});

test("Claude child stream and result cannot become parent reply or complete parent turn; native tasks stay visible", async t => {
  t.mock.method(sshAccess, "instructions", async () => undefined);
  const id = "claude_parent", thread = { nativeThreadId: id, projectId: project.id, sessionCwd: project.root } as ManagedThread;
  const events: Array<{ type: string; payload: Record<string, unknown>; nativeItemId?: string }> = [];
  let complete!: () => void; const completed = new Promise<void>(resolve => { complete = resolve; });
  let options!: Options;
  const runtime = new ClaudeRuntime({ findManagedThread: () => thread, findProject: () => project, onVolatile: event => { events.push(event); }, onEvent: async event => { events.push(event); if (event.type === "turn.completed") complete(); }, onExit: async () => {}, onApproval: async () => {}, onApprovalResolved: async () => {} } as AppServerCallbacks, "epoch", {
    detectClaude: async () => ({ installed: true, version: "2.1.285", path: "/bin/claude" }), nativeClaudeRunning: async () => false,
    inspectClaudeMetadata: async () => ({ models: [], quota: { available: false, observedAt: new Date().toISOString(), subscriptionType: null, windows: [] } }),
    getSessionInfo: async () => ({ sessionId: "parent", cwd: "/tmp", summary: "", lastModified: 0 }), listSubagents: async () => ["child"],
    query: input => {
      options = input.options!;
      return { close() {}, async *[Symbol.asyncIterator]() {
        const sent = await (input.prompt as AsyncIterable<{ uuid: string; message: { content: Array<{ text: string }> } }>)[Symbol.asyncIterator]().next();
        assert.equal(sent.value!.message.content[0]!.text, "Main task", "collaboration guidance must not be appended to visible user text");
        const result = { type: "result", is_error: false, num_turns: 1, user_message_uuid: sent.value!.uuid, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
        yield { type: "system", subtype: "task_started", session_id: "parent", task_id: "child", task_type: "local_agent", subagent_type: "Reviewer", description: "Review the change" };
        yield { type: "system", subtype: "task_started", session_id: "parent", task_id: "shell", task_type: "local_bash", description: "Not a child agent" };
        yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "parent-reply" } } };
        yield { type: "stream_event", parent_tool_use_id: "child-tool", event: { type: "message_start", message: { id: "child-reply" } } };
        yield { type: "stream_event", parent_tool_use_id: "child-tool", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Child delta" } } };
        yield { type: "assistant", parent_tool_use_id: "child-tool", message: { id: "child-reply", content: [{ type: "text", text: "Child answer" }] } };
        yield { ...result, parent_tool_use_id: "child-tool" };
        assert.equal(events.length, 1, "only the submitted parent user message is recorded");
        yield { type: "system", subtype: "task_notification", session_id: "parent", task_id: "child", status: "completed", summary: "Review done" };
        yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Parent delta" } } };
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "parent-reply", content: [{ type: "text", text: "Parent synthesis" }] } };
        yield result;
      } } as unknown as Query;
    },
  });
  await runtime.start(); await runtime.startTurn(thread, project, "Main task", undefined, undefined, undefined, { attachments: [], ...{ nativeCollaboration: true } }); await completed;
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.equal(events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(events.find(event => event.type === "agent_message.delta")?.nativeItemId, "parent-reply:text");
  assert.equal(JSON.stringify(events).includes("Child"), false);
  const page = await runtime.readNativeSubagents(id, project, "/tmp");
  assert.deepEqual(page.items, [{ id: "child", title: "Reviewer", status: "completed", description: "Review done" }]);
  await runtime.stop();
});

for (const ending of ["parent-result", "stream-error", "release"] as const) test(`Claude ${ending} loses unconfirmed child running state and preserves reported terminal outcomes`, async () => {
  const id = "claude_parent", thread = { nativeThreadId: id, projectId: project.id, sessionCwd: project.root } as ManagedThread;
  let terminalStatus: string | undefined;
  let ready!: () => void, finish!: () => void, terminal!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { finish = resolve; }), ended = new Promise<void>(resolve => { terminal = resolve; });
  const runtime = new ClaudeRuntime({ findManagedThread: () => thread, findProject: () => project, onVolatile: () => {}, onEvent: async event => { if (event.type === "turn.completed") { terminalStatus=(event.payload.turn as {status:string}).status; terminal(); } }, onExit: async () => {}, onApproval: async () => {}, onApprovalResolved: async () => {} } as AppServerCallbacks, "epoch", {
    detectClaude: async () => ({ installed: true, version: "2.1.285", path: "/bin/claude" }), nativeClaudeRunning: async () => false,
    inspectClaudeMetadata: async () => ({ models: [], quota: { available: false, observedAt: new Date().toISOString(), subscriptionType: null, windows: [] } }),
    getSessionInfo: async () => ({ sessionId: "parent", cwd: "/tmp", summary: "", lastModified: 0 }), listSubagents: async () => [],
    query: input => ({ close() { finish(); }, async *[Symbol.asyncIterator]() {
      const sent = await (input.prompt as AsyncIterable<{ uuid: string }>)[Symbol.asyncIterator]().next();
      for (const name of ["unconfirmed", "completed", "failed", "stopped", "killed"]) {
        yield { type: "system", subtype: "task_started", session_id: "parent", task_id: name, task_type: "local_agent", description: name };
        if (name !== "unconfirmed") yield name === "killed"
          ? { type: "system", subtype: "task_updated", session_id: "parent", task_id: name, patch: { status: name } }
          : { type: "system", subtype: "task_notification", session_id: "parent", task_id: name, status: name, summary: name };
      }
      for (const flags of [{ skip_transcript: true }, { ambient: true }]) {
        yield { type: "system", subtype: "task_started", session_id: "parent", task_id: "internal", task_type: "local_agent", subagent_type: "internal worker", ...flags };
        yield { type: "system", subtype: "task_progress", session_id: "parent", task_id: "internal", subagent_type: "internal worker", description: "flags omitted on progress" };
        yield { type: "system", subtype: "task_notification", session_id: "parent", task_id: "internal", status: "completed" };
      }
      ready(); await released;
      if (ending === "stream-error") throw Error("Disconnected native stream");
      yield { type: "result", is_error: false, num_turns: 1, user_message_uuid: sent.value!.uuid, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    } } as unknown as Query),
  });
  await runtime.start(); await runtime.startTurn(thread, project, "Main task"); await started;
  const before = await runtime.readNativeSubagents(id, project, "/tmp");
  assert.equal(before.items.find(item => item.id === "unconfirmed")?.status, "running");
  assert.equal(before.items.some(item => item.id === "internal"), false, "internal events and later progress cannot register a visible child");
  if (ending === "release") await runtime.unsubscribeThread(id);
  else { finish(); await ended; }
  assert.equal(terminalStatus,ending==="release"?undefined:"failed","EOF while waiting for children cannot report success");
  await new Promise(resolve => setImmediate(resolve));
  const after = await runtime.readNativeSubagents(id, project, "/tmp");
  assert.deepEqual(Object.fromEntries(after.items.map(item => [item.id, item.status])), { completed: "completed", failed: "failed", killed: "killed", stopped: "stopped", unconfirmed: "unknown" });
  await runtime.stop();
});

test('late host discovery cannot overwrite a newly selected managed runtime; switching back clears managed flag',async()=>{
 let resolve!: (value:{installed:boolean;version:string;path:string})=>void;
 let calls=0;
 const runtime=new ClaudeRuntime({} as AppServerCallbacks,'epoch',{
  detectClaude:async()=>{calls++;if(calls===1)return new Promise(r=>{resolve=r;});return {installed:true,version:'new',path:'/managed/claude',managed:calls===2};},
  inspectClaudeMetadata:async()=>({models:[],quota:{observedAt:new Date().toISOString(),available:false,subscriptionType:null,windows:[]}})
 });
 const old=runtime.start();await runtime.start();resolve({installed:true,version:'old',path:'/host/claude'});await old;
 assert.equal(runtime.availability.version,'new');assert.equal(runtime.availability.managed,true);
 await runtime.start();assert.equal(runtime.availability.managed,false);
});

test('damaged optional Claude runtime is reported without failing shared runtime startup',async()=>{
 const runtime=new ClaudeRuntime({} as AppServerCallbacks,'epoch',{detectClaude:async()=>{throw new Error('checksum mismatch');}});
 await runtime.start();assert.equal(runtime.availability.installed,false);assert.match(runtime.availability.error??'',/其他智能体不受影响/);
});


for(const merged of [true,false])test(`Claude steering retains native stream until all accepted UUIDs complete (merged=${merged})`,async()=>{
 const id="claude_12345678-1234-1234-1234-123456789012";
 const thread={nativeThreadId:id,projectId:project.id,sessionCwd:project.root} as ManagedThread;
 const events:Array<{type:string;nativeTurnId?:string;payload?:Record<string,unknown>}>=[];
 const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>();
 let queries=0,turnId:string;
 const runtime=new ClaudeRuntime({findManagedThread:()=>thread,findProject:()=>project,onVolatile:()=>{},onExit:async()=>{},onApprovalResolved:async()=>{},onApproval:async()=>{},onEvent:async e=>{events.push(e);if(e.type==='turn.completed')finished.resolve();}} as AppServerCallbacks,'epoch',{
  detectClaude:async()=>({installed:true,version:'2.1.296 (Claude Code)',path:'/bin/claude'}),nativeClaudeRunning:async()=>false,
  query:({prompt})=>{queries++;return {close(){},async *[Symbol.asyncIterator](){
   const input=(prompt as AsyncIterable<{uuid:string;message:{content:Array<{type:string}>}}>)[Symbol.asyncIterator]();
   const first=await input.next();started.resolve();await gate.promise;
   const second=await input.next();assert.equal(second.value!.message.content[1]?.type,'image');
   const result={type:'result',is_error:false,num_turns:1,modelUsage:{},usage:{input_tokens:1,output_tokens:1}};
   if(!merged){yield {...result,user_message_uuids:[first.value!.uuid]};assert.equal(events.filter(e=>e.type==='turn.completed').length,0);}
   yield {...result,user_message_uuids:merged?[first.value!.uuid,second.value!.uuid]:[second.value!.uuid]};
  }} as unknown as Query;}
 });
 await runtime.start();assert.equal(runtime.availability.steerSupported,true);
 const turn=await runtime.startTurn(thread,project,'original');turnId=turn.nativeTurnId!;await started.promise;
 await assert.rejects(runtime.steerTurn(thread,'stale','not sent'),/变化/);
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 await runtime.steerTurn(thread,turnId,'additional','11111111-1111-4111-8111-111111111111',[image]);
 await runtime.steerTurn(thread,turnId,'additional','11111111-1111-4111-8111-111111111111',[image]);
 gate.resolve();await finished.promise;
 assert.equal(queries,1);assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
 const users=events.filter(e=>e.type==='item.completed').map(e=>e.payload!.item as {type:string;content:unknown[]});
 assert.equal(users.length,2,"accepted original and additional prompts appear once");
 assert.ok(users.every(item=>item.type==='userMessage'));
 assert.deepEqual(users[1]!.content,[{type:'text',text:'additional'},{type:'image',url:image}]);
 assert.ok(events.every(e=>e.nativeTurnId===turnId));
 await assert.rejects(runtime.steerTurn(thread,turnId,'late'),/变化/);await runtime.stop();
});

test("Claude image-only history remains a user message with the same native identity",async()=>{
 const runtime=new ClaudeRuntime({} as AppServerCallbacks,"epoch",{
   getSessionInfo:async()=>({sessionId:"original",summary:"",cwd:"/tmp",lastModified:0}),
   getSessionMessages:async()=>[
     {type:"user",uuid:"image-user",session_id:"original",parent_tool_use_id:null,parent_agent_id:null,
      message:{content:[{type:"image",source:{type:"base64",media_type:"image/png",data:"aGVsbG8="}}]}},
   ],
 });
 const page=await runtime.readHistoryPage("claude_original",null);
 assert.deepEqual(page.items[0]?.item,{id:"image-user:text",type:"userMessage",content:[{type:"image",url:"data:image/png;base64,aGVsbG8="}]});
});
