// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mapEvent } from "./lib/api";
import { timelineItems } from "./lib/timeline-items";
import { isBuzhoushanChatEvent } from "./lib/buzhoushan-events";
import type { TimelineEvent } from "./lib/types";
const start: TimelineEvent = { id: "start", type: "item.started", sessionSeq: 304, occurredAt: "2026-09-07T11:29:07Z", nativeThreadId: "thread", nativeTurnId: "turn", nativeItemId: "item", actor: "user", body: "这是什么图片", payloadState: "present", images: ["image"] };
const done: TimelineEvent = { ...start, id: "done", type: "item.completed", sessionSeq: 305 };

it("displays agent warning details without exposing structured metadata or unrelated command details", () => {
  const detail = "宿主机历史发生压缩或重写；已重新建立同步游标，旧内容不会重复导入";
  const warning = mapEvent({ type: "agent.warning", payload: { code: "HISTORY_CURSOR_REBASED", detail, invalidatedApprovalIds: ["internal-id"] } });
  expect(warning).toMatchObject({ title: "Agent 警告", actor: "system", body: detail });
  expect(timelineItems([warning])[0].body).toBe(detail);
  expect(JSON.stringify(warning)).not.toContain("internal-id");
  expect(mapEvent({ type: "agent.warning", payload: { message: "Public warning", detail } }).body).toBe("Public warning");
  expect(mapEvent({ type: "agent.warning", payload: { detail: { internal: "not for display" } } }).body).toBeNull();
  expect(mapEvent({ type: "command.result", payload: { detail: "internal command detail" } }).body).toBeNull();
});

it.each(['THREAD_WRITER_BUSY','PROVIDER_NATIVE_BUSY','PROVIDER_OWNERSHIP_UNKNOWN'])("shows preflight refusal %s in chat, including Buzhoushan",code=>{
  const event=mapEvent({type:'command.result',payload:{state:'applied',commandType:'turn.start',detail:{code,message:'native refusal',private:'not for display'}}});
  expect(event).toMatchObject({title:'请求未执行成功',status:'failed'});
  expect(event.body).toContain('任务未启动');expect(event.body).toContain(code);
  expect(JSON.stringify(event)).not.toContain('not for display');
  expect(isBuzhoushanChatEvent(event)).toBe(true);
});
it('keeps uncertain command outcomes distinct from known refusal and successful receipts',()=>{
  const event=mapEvent({type:'command.result',payload:{state:'unknown',detail:{error:{code:'APP_SERVER_TIMEOUT',message:'Outcome unknown'}}}});
  expect(event).toMatchObject({status:'unknown',body:'Outcome unknown (APP_SERVER_TIMEOUT)'});
  expect(event.body).not.toContain('任务未启动');expect(isBuzhoushanChatEvent(event)).toBe(true);
  const success=mapEvent({type:'command.result',payload:{state:'applied',detail:{nativeTurnId:'turn'}}});
  expect(success).toMatchObject({title:'远端命令结果',status:null,body:null});
  expect(isBuzhoushanChatEvent(success)).toBe(false);
});

const receipt = (commandId: string | undefined, sessionSeq: number, state: string, code?: string) => mapEvent({
  eventId: `receipt-${sessionSeq}`, type: "command.result", sessionSeq,
  occurredAt: `2026-10-18T01:15:${String(sessionSeq).padStart(2, "0")}Z`,
  payload: { commandId, state, commandType: "turn.start", ...(code ? { detail: { code, message: "native refusal" } } : {}) },
});

it("同一请求的 claimed、invoking、responded、applied 仅显示一条最终回执", () => {
  const claimed = receipt("cmd-one", 1, "claimed");
  const invoking = receipt("cmd-one", 2, "invoking");
  const responded = receipt("cmd-one", 3, "responded", "THREAD_WRITER_BUSY");
  const applied = receipt("cmd-one", 4, "applied", "THREAD_WRITER_BUSY");
  const events = [claimed, invoking, responded, applied];
  expect(applied.commandId).toBe("cmd-one");
  expect(timelineItems(events)).toEqual([{ ...applied, id: "command-result:cmd-one" }]);
  expect(timelineItems([...events].reverse())).toEqual(timelineItems(events));
  expect(timelineItems([claimed])[0].id).toBe(timelineItems(events)[0].id);
  expect(timelineItems(events).filter(isBuzhoushanChatEvent)).toHaveLength(1);
});

it("相同错误的不同请求与缺失请求身份的回执不会误合并", () => {
  const events = [
    receipt("cmd-one", 1, "applied", "THREAD_WRITER_BUSY"),
    receipt("cmd-two", 2, "applied", "THREAD_WRITER_BUSY"),
    receipt(undefined, 3, "applied", "THREAD_WRITER_BUSY"),
    receipt(undefined, 4, "applied", "THREAD_WRITER_BUSY"),
  ];
  expect(timelineItems(events)).toHaveLength(4);
  expect(new Set(timelineItems(events).map(event => event.id)).size).toBe(4);
});

it("请求回执旧状态不会覆盖未知结果，仅更新的明确结果才能解除未知", () => {
  const old = receipt("cmd-one", 1, "responded", "THREAD_WRITER_BUSY");
  const unknown = receipt("cmd-one", 2, "unknown", "APP_SERVER_TIMEOUT");
  const applied = receipt("cmd-one", 3, "applied");
  expect(timelineItems([unknown, old])).toEqual([{ ...unknown, id: "command-result:cmd-one" }]);
  expect(timelineItems([applied, unknown, old])).toEqual([{ ...applied, id: "command-result:cmd-one" }]);
});

it("请求回执正文删除后不会从其他生命周期事件恢复，原事件不被修改", () => {
  const old = receipt("cmd-one", 1, "responded", "THREAD_WRITER_BUSY");
  const deleted = { ...old, payloadState: "deleted" as const, body: null, images: [] };
  const recent = receipt("cmd-one", 2, "applied", "THREAD_WRITER_BUSY");
  for (const events of [[deleted, recent], [recent, deleted]]) {
    expect(timelineItems(events)).toEqual([{ ...deleted, id: "command-result:cmd-one" }]);
  }
  expect(recent.id).toBe("receipt-2");
  expect(recent.body).toContain("THREAD_WRITER_BUSY");
});

it("同一原生消息的开始、完成和重复导入仅显示一次，使用稳定滚动锚点", () => {
  const result = timelineItems([start, done, { ...done, id: "imported", sessionSeq: 310 }]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: "item.completed", body: "这是什么图片", images: ["image"] });
  expect(result[0].id).toBe(timelineItems([start])[0].id);
  expect(result[0].id).toBe(timelineItems([done])[0].id);
  expect(timelineItems([done, start])[0].type).toBe("item.completed");
});
it("相同文字但不同消息、轮次或线程不能误合并；缺失身份的事件保留", () => {
  const events = [start, { ...done, nativeItemId: "second" }, { ...done, nativeTurnId: "second" }, { ...done, nativeThreadId: "second" }, { ...done, nativeItemId: undefined }, { ...done, nativeTurnId: undefined }];
  expect(timelineItems(events)).toHaveLength(events.length);
});
it("命令完成更新原卡片输出，删除记录不被旧事件恢复", () => {
  const output = timelineItems([{ ...start, command: "test", output: null }, { ...done, command: "test", output: "passed" }]);
  expect(output).toHaveLength(1); expect(output[0].output).toBe("passed");
  const deleted = { ...done, payloadState: "deleted" as const, images: [], body: null };
  expect(timelineItems([deleted, start])[0]).toMatchObject({ payloadState: "deleted", body: null, images: [] });
});
it("API 保留原生身份以合并真实 started/completed 图文事件", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const events = ["item.started", "item.completed"].map((type, i) => mapEvent({ eventId: `event-${i}`, type, sessionSeq: i + 1, nativeThreadId: "thread", nativeTurnId: "turn", payloadState: "present", payload: { item: { id: "native-item", type: "userMessage", content: [{ type: "text", text: "这是什么图片" }, { type: "image", url: png }] } } }));
  expect(timelineItems(events)).toHaveLength(1);
  expect(timelineItems(events)[0]).toMatchObject({ nativeItemId: "native-item", images: [png], body: "这是什么图片" });
});
it("把同一原生轮次的用量附加到 Turn 完成，并隐藏独立用量事件", () => {
  const completed = mapEvent({ eventId: "completed", type: "turn.completed", sessionSeq: 12, nativeThreadId: "thread", nativeTurnId: "turn", payload: { turn: { id: "turn", status: "completed" } } });
  const usage = (id: string, sessionSeq: number, totalTokens: number, lastTokens: number, inputTokens: number, lastInputTokens: number, cachedInputTokens: number, lastCachedInputTokens: number) => mapEvent({ eventId: id, type: "thread.usage", sessionSeq, nativeThreadId: "thread", nativeTurnId: "turn", payload: { usage: {
    total: { inputTokens, outputTokens: totalTokens - inputTokens, cachedInputTokens, reasoningOutputTokens: 0, totalTokens },
    last: { inputTokens: lastInputTokens, outputTokens: lastTokens - lastInputTokens, cachedInputTokens: lastCachedInputTokens, reasoningOutputTokens: 0, totalTokens: lastTokens },
  } } });
  expect(timelineItems([completed, usage("first", 10, 1000, 100, 800, 80, 600, 60), usage("second", 11, 1050, 50, 840, 40, 630, 30), usage("duplicate", 13, 1050, 50, 840, 40, 630, 30)]))
    .toEqual([expect.objectContaining({ id: "completed", turnTokens: 150, turnCacheHitRate: 75 })]);
  expect(timelineItems([completed])[0]).toMatchObject({ id: "completed", turnTokens: null, turnCacheHitRate: null });
});
it("累计计数器重置时采用原生末次请求，零输入不虚构缓存命中率", () => {
  const completed = mapEvent({ eventId: "completed", type: "turn.completed", sessionSeq: 3, nativeThreadId: "thread", nativeTurnId: "turn", payload: { turn: { id: "turn", status: "completed" } } });
  const first = mapEvent({ eventId: "first", type: "thread.usage", sessionSeq: 1, nativeThreadId: "thread", nativeTurnId: "turn", payload: { usage: {
    total: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 45, reasoningOutputTokens: 0, totalTokens: 100 },
    last: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 45, reasoningOutputTokens: 0, totalTokens: 100 },
  } } });
  const reset = mapEvent({ eventId: "reset", type: "thread.usage", sessionSeq: 2, nativeThreadId: "thread", nativeTurnId: "turn", payload: { usage: {
    total: { inputTokens: 0, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 },
    last: { inputTokens: 0, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10 },
  } } });
  expect(timelineItems([first, reset, completed])[0]).toMatchObject({ turnTokens: 110, turnCacheHitRate: 50 });
  expect(timelineItems([reset, completed])[0]).toMatchObject({ turnTokens: 10, turnCacheHitRate: null });
});
it("Claude 原生顺序纠正补同步错位，并合并历史和实时回复", () => {
  const message=(seq:number,item:string,text:string,type:string,turn:string)=>mapEvent({eventId:`e${seq}`,sessionSeq:seq,type:"item.completed",nativeThreadId:"claude_original",nativeTurnId:turn,nativeItemId:item,payload:{item:{id:item,type,text,content:[{type:"text",text}]}}});
  const order=mapEvent({eventId:"order",sessionSeq:4,type:"thread.history.order",nativeThreadId:"claude_original",payload:{items:[{itemId:"user",index:0,occurredAt:"2026-09-30T06:00:00Z"},{itemId:"answer",index:100,occurredAt:"2026-09-30T06:00:01Z"}]}});
  const result=timelineItems([message(1,"answer","reply","agentMessage","live-turn"),message(2,"user","429?","userMessage","history-user"),message(3,"answer","reply","agentMessage","history-answer"),order]);
  expect(result.map(e=>e.body)).toEqual(["429?","reply"]);
  expect(result[0]?.occurredAt).toBe("2026-09-30T06:00:00Z");
});

it("原生进度更新同一卡片，旧事件和另一轮任务不能覆盖完成状态", () => {
  const running = mapEvent({ type: "codex.hook_status", eventId: "hook-start", sessionSeq: 1, nativeThreadId: "thread", nativeTurnId: "turn", nativeItemId: "hook", payload: { message: "running" } });
  const completed = { ...running, id: "hook-done", sessionSeq: 2, body: "completed" };
  expect(timelineItems([completed, running])).toEqual([expect.objectContaining({ body: "completed", title: "Hook 状态" })]);
  expect(timelineItems([running, completed, { ...completed, nativeTurnId: "other" }])).toHaveLength(2);
  const deleted = { ...completed, payloadState: "deleted" as const, body: null };
  expect(timelineItems([deleted, running])[0]).toMatchObject({ payloadState: "deleted", body: null });
});

it("工具结果和推理进入时间线，原始参数和环境不会进入消息", () => {
  const tool = mapEvent({ eventId: "tool", sessionSeq: 1, type: "item.completed", nativeTurnId: "turn", payload: { item: { id: "tool", type: "mcpToolCall", tool: "Bash", arguments: { command: "npm test", raw: "secret" }, result: { text: "ok" } } } });
  expect(tool).toMatchObject({ command: "npm test", output: "ok", body: null, title: "npm test" });
  expect(JSON.stringify(tool)).not.toContain("secret");
  const thought = mapEvent({ eventId: "thought", sessionSeq: 2, type: "item.completed", nativeTurnId: "turn", payload: { item: { id: "thought", type: "reasoning", text: "public thought" } } });
  expect(thought.body).toBe("public thought");
  expect(thought.title).toBe("推理摘要");
  const error = mapEvent({ eventId: "error", sessionSeq: 3, type: "turn.error", nativeTurnId: "turn", payload: { message: "failed" } });
  expect(error.title).toBe("任务错误");
});
it('preserves native file changes for the workbench history fallback',()=>{
 const event=mapEvent({eventId:'file-edit',sessionSeq:1,type:'item.completed',nativeTurnId:'turn',payload:{item:{id:'edit',type:'fileChange',status:'completed',changes:[{path:'src/demo.ts',diff:'+ actual edit'}]}}});
 expect(event.fileChanges).toEqual([{path:'src/demo.ts',diff:'+ actual edit'}]);
});

const reasoning = (seq: number, summary: string[], type = 'item.started') => mapEvent({
  eventId: `summary-${seq}`, sessionSeq: seq, type, nativeThreadId: 'thread', nativeTurnId: 'turn', nativeItemId: 'summary', payloadState: 'present',
  payload: { item: { id: 'summary', type: 'reasoning', summary } },
});
it('hides empty public reasoning items but keeps messages and real summaries', () => {
  expect(timelineItems([reasoning(1, []), reasoning(2, ['  '], 'item.completed')])).toEqual([]);
  expect(timelineItems([reasoning(1, []), reasoning(2, ['Public explanation'])])).toHaveLength(1);
  expect(timelineItems([start])).toHaveLength(1);
});
it('summary snapshots update one card, survive empty completion and history reimport', () => {
  const events = [reasoning(1, []), reasoning(2, ['First']), reasoning(3, ['First part', 'Second']), reasoning(4, [], 'item.completed'), reasoning(5, [], 'item.completed')];
  const result = timelineItems(events);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: 'item.completed', body: 'First part\nSecond' });
  expect(result[0].id).toBe(timelineItems(events.slice(0, 2))[0].id);
  expect(timelineItems([reasoning(6, ['Authoritative'], 'item.completed'), ...events])[0].body).toBe('Authoritative');
});
it('deleted or suppressed public summaries cannot be resurrected by old snapshots', () => {
  const old = reasoning(1, ['Public explanation']);
  for (const payloadState of ['deleted', 'suppressed'] as const) {
    const removed = { ...reasoning(2, [], 'item.completed'), payloadState };
    expect(timelineItems([old, removed])).toEqual([]);
    expect(timelineItems([removed, old])).toEqual([]);
    expect(timelineItems([reasoning(1, ['Finished'], 'item.completed'), { ...removed, type: 'item.started' }])).toEqual([]);
  }
});

it.each(["codex", "claude", "grok", "cursor", "qwen", "kimi", "codebuddy", "gemini", "trae", "antigravity"])(
  "%s user questions retain the You label and body in the timeline",
  provider => {
    const event = mapEvent({
      eventId: "question", type: "item.completed", sessionSeq: 1,
      nativeThreadId: provider + "_thread", nativeTurnId: "turn", nativeItemId: "question:text",
      payloadState: "present",
      payload: {item: {id: "question:text", type: "userMessage", content: [{type: "text", text: "测试提问"}]}},
    });
    expect(timelineItems([event])).toHaveLength(1);
    expect(timelineItems([event])[0]).toMatchObject({actor: "user", title: "你", body: "测试提问"});
    expect(isBuzhoushanChatEvent(event)).toBe(true);
  },
);
