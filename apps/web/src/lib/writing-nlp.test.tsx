// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { eligibleNLPDraft, mergeWritingSuggestions, useChineseNLP } from "./writing-nlp";
vi.mock("./api", () => ({ api: { writingNLP: vi.fn() } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const draft = "登录之后过一会儿就自己退出来了";
const response = { suggestions: [{ label: "排查登录会话意外失效", insertText: "排查登录会话意外失效", replaceStart: 0, replaceEnd: draft.length, intent: "session-expiry" }] };

it("debounces requests, hides obsolete responses and aborts on edits, session changes and opt out", async () => {
  vi.useFakeTimers();
  let finish!: (value: typeof response) => void;
  vi.mocked(api.writingNLP).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(response);
  const { result, rerender } = renderHook(({text,session,enabled}) => useChineseNLP("owner",session,text,enabled), {initialProps:{text:draft,session:"a",enabled:true}});
  await act(async () => { await vi.advanceTimersByTimeAsync(599); });
  expect(api.writingNLP).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const firstSignal=vi.mocked(api.writingNLP).mock.calls[0][2];
  rerender({text:"页面打开要等半天",session:"a",enabled:true});
  expect(firstSignal.aborted).toBe(true);
  await act(async () => { finish(response); });
  expect(result.current).toEqual([]);
  rerender({text:draft,session:"b",enabled:true});
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(api.writingNLP).toHaveBeenLastCalledWith("b",draft,expect.any(AbortSignal));
  expect(result.current[0]?.label).toBe(response.suggestions[0].label);
  rerender({text:draft,session:"b",enabled:false});
  expect(result.current).toEqual([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(api.writingNLP).toHaveBeenCalledTimes(2);
});

it("fails silently, times out and supports English and skips slash, code and obvious secret drafts", async () => {
  for (const text of ["/修复登录问题", "页面慢 password=secret", "页面慢 https://example.test", "`页面慢`", "中".repeat(2001)]) expect(eligibleNLPDraft(text)).toBe(false);
  expect(eligibleNLPDraft("I keep getting logged out")).toBe(true);
  vi.useFakeTimers();
  vi.mocked(api.writingNLP).mockImplementation(() => new Promise(() => {}));
  const {result}=renderHook(() => useChineseNLP("owner","a",draft,true));
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(vi.mocked(api.writingNLP).mock.calls[0][2].aborted).toBe(true);
  expect(result.current).toEqual([]);
});

it("merges without duplicating or displacing the first immediate choice", () => {
  const local = Array.from({length:5},(_,i)=>({label:`local ${i}`,insertText:"term",detail:"",kind:"term" as const,replaceStart:0,replaceEnd:4}));
  const remote = {...local[0],label:"NLP",kind:"rewrite" as const};
  expect(mergeWritingSuggestions(local,[remote]).map(item=>item.label)).toEqual(["local 0","local 1","local 2","local 3","local 4","NLP"]);
  expect(mergeWritingSuggestions(local,[local[0]])).toEqual(local);
});
