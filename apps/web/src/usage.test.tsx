// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UsageButton } from "./components/UsageButton";
import { UsageView } from "./components/UsageView";
import { api } from "./lib/api";
import type { UsageSummary } from "./lib/usage";
import { setLocale } from "./i18n";
vi.mock("./lib/api",()=>({api:{usage:vi.fn(),hostOperation:vi.fn(),refreshQuota:vi.fn()}}));
const counts={inputTokens:800,outputTokens:200,cachedInputTokens:300,reasoningOutputTokens:100,totalTokens:1000};
const data:UsageSummary={scope:"project",recorded:counts,quotaCycle:null,observedSessions:1,totalSessions:3,firstObservedAt:"2026-09-10T00:00:00Z",lastObservedAt:"2026-09-10T00:00:00Z",coverage:"observed-only",discontinuities:0,last:null,nativeTotal:null,modelContextWindow:null,topWeeklyProjects:null,topWeeklySessions:null,topProjects:[],topSessions:[{id:"s1",title:"Example task",totalTokens:1000}],accounts:[{sourceMachine:"Demo host",identityKnown:true,observedAt:new Date().toISOString(),stale:false,credits:{balance:"2350.5",hasCredits:true,unlimited:false},windows:[{bucket:"codex",window:"secondary",windowMinutes:10080,usedPercent:62,remainingPercent:38,resetsAt:1900000000}]}]};
beforeEach(()=>{
 setLocale("zh-CN");
 if(!HTMLDialogElement.prototype.showModal)Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,writable:true,value:function(){}});
 if(!HTMLDialogElement.prototype.close)Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,writable:true,value:function(){}});
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();});
it("separates shared remaining quota from measured project tokens and opens the consuming session",async()=>{
 vi.mocked(api.usage).mockResolvedValue(data);const select=vi.fn();render(<UsageButton scope="project" id="p1" onSession={select}/>);
 fireEvent.click(await screen.findByRole("button",{name:/总消耗/}));
 expect(await screen.findByRole("dialog",{name:"用量与剩余额度"})).toBeTruthy();
 expect(screen.getByText("2,350.5 点")).toBeTruthy();
 expect(screen.getByText("已用 62% · 剩余 38%")).toBeTruthy();expect(screen.getByText("已获取 1 / 3 个会话")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Example task"}));expect(select).toHaveBeenCalledWith("s1");
});
it("does not turn missing telemetry into zero or retain another scope's result",async()=>{
 vi.mocked(api.usage).mockResolvedValueOnce(data).mockResolvedValue({...data,recorded:null,accounts:[],topSessions:[]});
 const view=render(<UsageButton scope="project" id="p1"/>);await screen.findByRole("button",{name:/总消耗/});
 view.rerender(<UsageButton scope="session" id="s2"/>);await screen.findByRole("button",{name:/总消耗 — tokens/});
 fireEvent.click(screen.getByRole("button",{name:/总消耗 — tokens/}));expect(await screen.findByText(/未获取不代表零消耗/)).toBeTruthy();expect(screen.queryByText("已用 62% · 剩余 38%")).toBeNull();
});
it("labels stale account snapshots and English UI explicitly",async()=>{
 setLocale("en");vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",accounts:[{...data.accounts[0],stale:true}]});
 render(<UsageButton scope="machine" id="m1"/>);fireEvent.click(await screen.findByRole("button",{name:/Weekly quota\s*38%/}));
 expect(await screen.findByText(/Out of date/)).toBeTruthy();expect(screen.getByText("Account quota (shared)")).toBeTruthy();
});

it("keeps quota discoverable with multiple model windows and no session token reports",async()=>{
 const account={...data.accounts[0],windows:[data.accounts[0].windows[0],{...data.accounts[0].windows[0],bucket:"model-specific",usedPercent:0,remainingPercent:100}]};
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",recorded:null,accounts:[account]});
 render(<UsageButton scope="machine" id="m1"/>);
 expect(await screen.findByRole("button",{name:/周额度\s*38%/})).toBeTruthy();
});
it("shows a temporary reset forecast only when supplied, and displays native reset cards",async()=>{
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",resetPrediction:{kind:"temporary-reset",signal:"announced" as const,publishedAt:"2026-09-23T12:00:00Z",evidence:"reset announced",expectedAt:"2026-09-24T12:00:00Z",observedAt:"2026-09-23T12:00:00Z",sourceUrl:"https://x.com/thsottiaux/status/123"},accounts:[{...data.accounts[0],resetCardsAvailable:2}]});
 render(<UsageButton scope="machine" id="m1"/>);
 fireEvent.click(await screen.findByRole("button",{name:/周额度\s*38%/}));
 expect(await screen.findByText(/已宣布将重置/)).toBeTruthy();
 expect(screen.getByText("可用重置卡 2 张")).toBeTruthy();
 expect(screen.getByRole("button",{name:"查看消息时间轴"})).toBeTruthy();
});
it("host card shows positive credits before a forecast, then the forecast when credits reach zero",async()=>{
 const prediction={kind:"temporary-reset" as const,signal:"announced" as const,publishedAt:"2026-09-23T12:00:00Z",evidence:"reset announced",expectedAt:"2026-09-24T12:00:00Z",observedAt:"2026-09-23T12:00:00Z",sourceUrl:"https://example.test/forecast"};
 vi.mocked(api.usage).mockResolvedValueOnce({...data,scope:"machine",resetPrediction:prediction}).mockResolvedValue({...data,scope:"machine",resetPrediction:prediction,accounts:[{...data.accounts[0],credits:{balance:"0",hasCredits:false,unlimited:false}}]});
 const view=render(<UsageButton scope="machine" id="m1"/>);
 const card=await screen.findByRole("button",{name:/周额度\s*38%/});
 expect(within(card).getByText("2,350.5")).toBeTruthy();
 expect(within(card).queryByText("临时重置预测")).toBeNull();
 document.dispatchEvent(new Event("visibilitychange"));
 await waitFor(()=>expect(within(card).getByText("临时重置预测")).toBeTruthy());
 expect(within(card).getByText(/已宣布将重置/)).toBeTruthy();
 expect(within(card).queryByText("点数余额")).toBeNull();
 view.unmount();
});
it("host card states that no forecast is available when credits are zero or unreported",async()=>{
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",accounts:[{...data.accounts[0],credits:{balance:"0",hasCredits:false,unlimited:false}}]});
 const view=render(<UsageButton scope="machine" id="m1"/>);
 const card=await screen.findByRole("button",{name:/周额度\s*38%/});
 expect(within(card).getByText("暂无预测")).toBeTruthy();
 view.unmount();
});

it("page polling never requests host quota; host refresh requires an explicit click",async()=>{
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine"});
 vi.mocked(api.refreshQuota).mockResolvedValue({requested:true});
 render(<UsageButton scope="machine" id="m1"/>);
 fireEvent.click(await screen.findByRole("button",{name:/周额度\s*38%/}));expect(api.hostOperation).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"刷新额度"}));
 expect(await screen.findByText("已请求主机刷新，结果以更新时间为准。")).toBeTruthy();expect(api.refreshQuota).toHaveBeenCalledWith("m1");
});
it("opening usage refreshes host consumption without waiting for the polling interval",async()=>{
 vi.mocked(api.usage).mockResolvedValueOnce({...data,scope:"session"}).mockResolvedValue({...data,scope:"session",recorded:{...counts,totalTokens:2500}});
 render(<UsageButton scope="session" id="s1"/>);
 fireEvent.click(await screen.findByRole("button",{name:/总消耗/}));
 await waitFor(()=>expect(api.usage).toHaveBeenCalledTimes(2));
 expect(await screen.findByText("2,500")).toBeTruthy();
});
it("shows the quota reset cycle and never substitutes a rolling week for an unknown reset",async()=>{
 vi.mocked(api.usage).mockResolvedValue({...data,quotaCycle:{startsAt:"2026-09-03T12:34:00Z",resetsAt:"2026-09-10T12:34:00Z",recordedTokens:42,boundaryIncomplete:true}});
 render(<UsageButton scope="session" id="cycle"/>);fireEvent.click(await screen.findByRole("button",{name:/总消耗/}));
 expect(await screen.findByText("42")).toBeTruthy();expect(screen.getByText(/跨越重置时刻/)).toBeTruthy();expect(screen.queryByText("近 7 个 UTC 日期")).toBeNull();
});

it("shows both quota windows and separate total and cycle project rankings",async()=>{
 const quotaCycle={startsAt:"2026-09-03T12:34:00Z",resetsAt:"2026-09-10T12:34:00Z",recordedTokens:20,boundaryIncomplete:false};
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",quotaCycle,accounts:[{...data.accounts[0],windows:[...data.accounts[0].windows,{bucket:"codex",window:"primary",windowMinutes:300,usedPercent:15,remainingPercent:85,resetsAt:1900000100}]}],topProjects:[{id:"old",title:"Old project",totalTokens:1000}],topWeeklyProjects:[{id:"new",title:"Active project",totalTokens:20}]});
 render(<UsageButton scope="machine" id="m1"/>);
 const button=await screen.findByRole("button",{name:/周额度\s*38%/});
 expect(button.textContent).toMatch(/5 小时额度\s*85%/);
 expect(button.textContent?.match(/下次重置/g)?.length).toBe(2);
 fireEvent.click(button);
 expect(await screen.findByText("项目总消耗排名（前 10）")).toBeTruthy();
 expect(screen.getByText("项目本周消耗排名（前 10）")).toBeTruthy();
 expect(screen.getByText("Active project")).toBeTruthy();
});

it("shows a dedicated host usage page with weekly cache rates and opens sessions",async()=>{
 const cycle={startsAt:"2026-09-04T00:00:00Z",resetsAt:"2026-09-11T00:00:00Z",recordedTokens:70,inputTokens:56,cachedInputTokens:21,boundaryIncomplete:false};
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",quotaCycle:cycle,projects:[{id:"p1",title:"AgentFleets",totalTokens:1020,weeklyTokens:20,weeklyInputTokens:16,weeklyCachedInputTokens:6}],sessions:[{id:"s1",title:"Usage page",totalTokens:50,weeklyTokens:50,weeklyInputTokens:40,weeklyCachedInputTokens:15}]});
 const select=vi.fn();render(<UsageView machines={[{id:"m1",name:"Demo host"} as never]} selectedId="m1" onSelect={vi.fn()} onSession={select}/>);
 expect(await screen.findByRole("heading",{name:"消耗"})).toBeTruthy();
 expect(screen.getAllByText("37.5%").length).toBeGreaterThanOrEqual(2);
 expect(screen.getByText("1,020")).toBeTruthy();
 expect(screen.getByText("1,020").closest("td")?.getAttribute("data-label")).toBe("总消耗");
 fireEvent.click(screen.getByRole("button",{name:"Usage page"}));expect(select).toHaveBeenCalledWith("s1");
});

it("limits usage tables to ten rows and paginates projects and sessions independently",async()=>{
 const entries=Array.from({length:12},(_,index)=>({id:`entry-${index+1}`,title:`A very long usage title ${index+1} that should stay on one line`,totalTokens:index+1,weeklyTokens:index+1,weeklyInputTokens:index+1,weeklyCachedInputTokens:0}));
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",projects:entries.map(entry=>({...entry,id:`project-${entry.id}`})),sessions:entries.map(entry=>({...entry,id:`session-${entry.id}`}))});
 render(<UsageView machines={[{id:"m1",name:"Demo host"} as never]} selectedId="m1" onSelect={vi.fn()} onSession={vi.fn()}/>);
 const projectPages=await screen.findByRole("navigation",{name:"项目分页"});
 const sessionPages=screen.getByRole("navigation",{name:"会话分页"});
 expect(screen.getAllByText("A very long usage title 10 that should stay on one line")).toHaveLength(2);
 expect(screen.queryByText("A very long usage title 11 that should stay on one line")).toBeNull();
 expect(screen.getAllByTitle("A very long usage title 1 that should stay on one line")[0].classList.contains("usage-table__name")).toBe(true);
 fireEvent.click(within(sessionPages).getByRole("button",{name:"下一页"}));
 expect(screen.getByRole("button",{name:"A very long usage title 11 that should stay on one line"})).toBeTruthy();
 expect(screen.getByText("A very long usage title 1 that should stay on one line")).toBeTruthy();
 fireEvent.click(within(projectPages).getByRole("button",{name:"第 2 页"}));
 expect(screen.getAllByText("A very long usage title 11 that should stay on one line")).toHaveLength(2);
});

it("keeps mobile usage concise and permits closing after expanding details",async()=>{
 const original=window.matchMedia;
 window.matchMedia=vi.fn().mockReturnValue({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 try {
  vi.mocked(api.usage).mockResolvedValue(data);
  render(<UsageButton scope="project" id="p1"/>);
  fireEvent.click(await screen.findByRole("button",{name:/总消耗/}));
  const dialog=screen.getByRole("dialog");
  expect(within(dialog).queryByText("账号额度（共享）")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button",{name:"查看完整明细"}));
  expect(within(dialog).getByText("账号额度（共享）")).toBeTruthy();
  fireEvent.click(within(dialog).getAllByRole("button",{name:"关闭用量"}).at(-1)!);
  await waitFor(()=>expect(dialog.hasAttribute("open")).toBe(false));
 } finally {window.matchMedia=original;}
});
it("clicking the forecast card opens the Chinese timeline without changing native reset dates",async()=>{
 const resetAt=data.accounts[0].windows[0].resetsAt;
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",accounts:[{...data.accounts[0],credits:{balance:"0",hasCredits:false,unlimited:false}}],resetRadar:{state:"ready",checkedAt:new Date().toISOString(),nextCheckAt:null,timeline:[{id:"42",publishedAt:new Date().toISOString(),summary:"介绍 Codex 最新功能",signal:"none",sourceUrl:"https://x.com/thsottiaux/status/42"}]}});
 render(<UsageButton scope="machine" id="m1"/>);
 const card=await screen.findByRole("button",{name:/周额度\s*38%/});
 fireEvent.click(within(card).getByText("临时重置预测"));
 const timeline=screen.getByRole("dialog",{name:"重置消息时间轴"});
 expect(within(timeline).getByText("介绍 Codex 最新功能")).toBeTruthy();
 expect(within(timeline).getByRole("link",{name:"查看原帖"}).getAttribute("href")).toBe("https://x.com/thsottiaux/status/42");
 expect(data.accounts[0].windows[0].resetsAt).toBe(resetAt);
});
it("Claude shows native subscription limits without Codex credits or reset forecasts",async()=>{
 vi.mocked(api.usage).mockResolvedValue({...data,provider:"claude",scope:"machine",accounts:[{sourceMachine:"B52H",identityKnown:false,subscriptionType:"pro",observedAt:new Date().toISOString(),stale:false,credits:null,windows:[{bucket:"claude",window:"seven_day",windowMinutes:10080,usedPercent:1,remainingPercent:99,resetsAt:1900000000},{bucket:"claude",window:"five_hour",windowMinutes:300,usedPercent:5,remainingPercent:95,resetsAt:1900000000}]}]});
 render(<UsageButton scope="machine" id="m1" provider="claude"/>);
 const card=await screen.findByRole("button",{name:/周额度\s*99%/});
 expect(within(card).getByText("95%")).toBeTruthy();expect(screen.queryByText("临时重置预测")).toBeNull();
 fireEvent.click(card);
 expect(screen.getByText("PRO · 由宿主机 Claude Code 原生查询")).toBeTruthy();
 expect(screen.queryByText("点数余额")).toBeNull();expect(screen.queryByText(/额度暂未接入/)).toBeNull();
});
