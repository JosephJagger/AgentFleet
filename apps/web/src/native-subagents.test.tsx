// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { NativeSubagents, NativeSubagentsTrigger, useNativeSubagents } from "./components/NativeSubagents";
import { api } from "./lib/api";
import type { FleetSession } from "./lib/types";
import type { NativeSubagentSnapshot } from "./lib/native-subagents";

vi.mock("./lib/api", () => ({ api: { nativeSubagents: vi.fn() } }));
const session = { id: "parent", title: "Main task", provider: "codex" } as FleetSession;
const child = { id: "child-a", title: "Research", status: "running", description: "Check official sources" };
const snapshot: NativeSubagentSnapshot = { provider: "codex", items: [child] };
function Harness({ id = "parent", enabled = true, initialOpen = false }: { id?: string; enabled?: boolean; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const state = useNativeSubagents(id, enabled, open);
  return <>{enabled && <NativeSubagentsTrigger state={state} open={open} onClick={() => setOpen(!open)}/>}{enabled && open && <NativeSubagents session={{ ...session, id }} state={state} onClose={() => setOpen(false)}/>}</>;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.nativeSubagents).mockResolvedValue({ provider: "codex", items: [] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("discovers native children while collapsed and never auto-opens or dispatches tasks", async () => {
  vi.useFakeTimers();
  vi.mocked(api.nativeSubagents).mockResolvedValueOnce({ provider: "codex", items: [] }).mockResolvedValueOnce(snapshot).mockResolvedValue({ ...snapshot, items: [{ ...child, status: "completed" }] });
  render(<Harness/>);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "子 Agent" }).textContent).toContain("0");
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.getByText("1 执行中")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "子 Agent 进度" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.queryByText("1 执行中")).toBeNull();
  expect(vi.mocked(api.nativeSubagents).mock.calls.every(([id, input]) => id === "parent" && JSON.stringify(input) === "{}")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "子 Agent" }));
  expect(screen.getByText("已完成")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /安排分工|确认分工|汇总结果/ })).toBeNull();
});

it("shows honest empty copy and the provider without a manual task form", async () => {
  vi.mocked(api.nativeSubagents).mockResolvedValue({ provider: "claude", items: [] });
  render(<Harness initialOpen/>);
  expect(await screen.findByText("暂未发现子 Agent")).toBeTruthy();
  expect(screen.getByText("Claude Code")).toBeTruthy();
  expect(screen.getByText("直接在主会话说明目标，主助手会按需要分工。")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("loads task and reply after selecting a child and masks sensitive labels", async () => {
  const name = "gongqiankun research";
  vi.mocked(api.nativeSubagents).mockImplementation(async (_id, input) => input?.childId ? { ...snapshot, childId: child.id, messages: [{ role: "user", text: "Read cupshe information" }, { role: "assistant", text: "Reviewed the sources", status: "completed" }] } : { ...snapshot, items: [{ ...child, title: name }] });
  render(<Harness initialOpen/>);
  fireEvent.click(await screen.findByRole("button", { name: /g\*\*\*\*n research/ }));
  expect(await screen.findByText("Reviewed the sources")).toBeTruthy();
  expect(screen.getByText("Read c****e information")).toBeTruthy();
  expect(vi.mocked(api.nativeSubagents).mock.calls.some(([id, input]) => id === "parent" && input?.childId === child.id)).toBe(true);
});

it("late replies from a previously selected child cannot replace current child history", async () => {
  const old = deferred<NativeSubagentSnapshot>();
  const list = { ...snapshot, items: [child, { ...child, id: "child-b", title: "Review" }] };
  vi.mocked(api.nativeSubagents).mockImplementation(async (_id, input) => input?.childId === "child-a" ? old.promise : input?.childId === "child-b" ? { ...list, childId: "child-b", messages: [{ role: "assistant", text: "Current child reply" }] } : list);
  render(<Harness initialOpen/>);
  fireEvent.click(await screen.findByRole("button", { name: /Research/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
  expect(await screen.findByText("Current child reply")).toBeTruthy();
  await act(async () => old.resolve({ ...snapshot, childId: "child-a", messages: [{ role: "assistant", text: "Stale reply" }] }));
  expect(screen.queryByText("Stale reply")).toBeNull();
  expect(screen.getByText("Current child reply")).toBeTruthy();
});

it("switching parent cancels requests and ignores stale failure", async () => {
  const old = deferred<NativeSubagentSnapshot>();
  vi.mocked(api.nativeSubagents).mockImplementation(async id => id === "parent" ? old.promise : { provider: "claude", items: [] });
  const view = render(<Harness initialOpen/>);
  const oldSignal = vi.mocked(api.nativeSubagents).mock.calls[0][2];
  view.rerender(<Harness id="other" initialOpen/>);
  expect(oldSignal?.aborted).toBe(true);
  expect(await screen.findByText("Claude Code")).toBeTruthy();
  await act(async () => old.reject(new Error("Stale error")));
  expect(screen.queryByText("Stale error")).toBeNull();
});

it("keeps last known progress on failure and refresh recovers without replay", async () => {
  vi.useFakeTimers();
  vi.mocked(api.nativeSubagents).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Connection unavailable")).mockResolvedValue({ ...snapshot, items: [{ ...child, status: "completed" }] });
  render(<Harness initialOpen/>);
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.getByRole("alert").textContent).toContain("Connection unavailable");
  expect(screen.getByRole("button", { name: /Research/ })).toBeTruthy();
  expect(screen.getByText("保留最后已知状态")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新子 Agent 进度" }));
  await act(async () => {});
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("已完成")).toBeTruthy();
});

it("closing pane stops history reads but continues lightweight discovery", async () => {
  vi.useFakeTimers();
  vi.mocked(api.nativeSubagents).mockImplementation(async (_id, input) => input?.childId ? { ...snapshot, childId: child.id, messages: [] } : snapshot);
  render(<Harness initialOpen/>);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /Research/ }));
  await act(async () => {});
  const historyCalls = () => vi.mocked(api.nativeSubagents).mock.calls.filter(([, input]) => input?.childId).length;
  expect(historyCalls()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "收起子 Agent" }));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(historyCalls()).toBe(1);
  expect(api.nativeSubagents).toHaveBeenCalledTimes(4);
});

it("other themes or unmanaged sessions do not read or show native children", async () => {
  const view = render(<Harness enabled={false} initialOpen/>);
  expect(api.nativeSubagents).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "子 Agent" })).toBeNull();
  view.rerender(<Harness enabled initialOpen/>);
  await waitFor(() => expect(api.nativeSubagents).toHaveBeenCalledOnce());
  const signal = vi.mocked(api.nativeSubagents).mock.calls[0][2];
  view.rerender(<Harness enabled={false} initialOpen/>);
  expect(signal?.aborted).toBe(true);
});

it("reads paginated child history with the same parent and child IDs", async () => {
  vi.mocked(api.nativeSubagents).mockImplementation(async (_id, input) => !input?.childId ? snapshot : input.cursor ? { ...snapshot, childId: child.id, messages: [{ role: "assistant", text: "Older reply" }], nextCursor: null } : { ...snapshot, childId: child.id, messages: [{ role: "assistant", text: "Latest reply" }], nextCursor: "older-page" });
  render(<Harness initialOpen/>);
  fireEvent.click(await screen.findByRole("button", { name: /Research/ }));
  expect(await screen.findByText("Latest reply")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("Older reply")).toBeTruthy();
  expect(api.nativeSubagents).toHaveBeenLastCalledWith("parent", { childId: child.id, cursor: "older-page" }, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  expect(await screen.findByText("Latest reply")).toBeTruthy();
});

it("marks a long reply as a segment instead of claiming it is the whole reply", async () => {
  vi.mocked(api.nativeSubagents).mockImplementation(async (_id, input) => !input?.childId ? snapshot : { ...snapshot, childId: child.id, messages: [{ id: "long-reply", role: "assistant", text: "Part", truncated: true, textOffset: 20_000, textLength: 60_000 }], nextCursor: "next-segment" });
  render(<Harness initialOpen/>);
  fireEvent.click(await screen.findByRole("button", { name: /Research/ }));
  expect(await screen.findByText(/长消息分段显示，当前为第 20001–20004 \/ 60000 字符/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(false);
});
