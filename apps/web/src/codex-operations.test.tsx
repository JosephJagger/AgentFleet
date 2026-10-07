// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeSessionActions } from "./components/NativeSessionActions";
import { CodexOperationsPanel } from "./components/CodexOperationsPanel";
import { api } from "./lib/api";
import type { CommandReceipt, FleetSession, Machine, HostOperation } from "./lib/types";
vi.mock("./lib/api", () => ({ api: { hostCodexOperation: vi.fn(), command: vi.fn() } }));
afterEach(cleanup); beforeEach(() => vi.clearAllMocks());
const session = { id: "s", nativeThreadId: "thread", executionSegmentId: "segment", threadControlVersion: 4, projectLeaseVersion: 2, activeTurnId: null, actions: { manage: { allowed: true } } } as FleetSession;

it("reading usage is explicit and unavailable telemetry is not rendered as zero", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "request" } as CommandReceipt });
  const changed = vi.fn();
  const view = render(<CodexOperationsPanel session={session} commands={[]} onChanged={changed} />);
  fireEvent.click(screen.getByText("Codex 工具与账号", { selector: "summary > span" }));
  expect(api.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "读取官方用量" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("s", expect.objectContaining({ type: "codex.manage", payload: { operation: "usage.read", arguments: { scope: "account" } } }));
  view.rerender(<CodexOperationsPanel session={session} commands={[{ id: "request", type: "codex.manage", createdAt: "now", state: "applied", codexResult: { operation: "usage.read", status: "unavailable", rows: [] } } as CommandReceipt]} onChanged={changed} />);
  expect(screen.getByText("当前账号未返回此项数据，无法据此计算用量。")).toBeTruthy();
});

it("reset credit consumption requires a separate explicit confirmation and exact session precondition", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "reset" } as CommandReceipt });
  render(<CodexOperationsPanel session={session} commands={[]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText("Codex 工具与账号", { selector: "summary > span" }));
  fireEvent.change(screen.getByLabelText("操作"), { target: { value: "resetCard.consume" } });
  const button = screen.getByRole("button", { name: "使用重置卡" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "确认在此宿主机执行所选操作" })); fireEvent.click(button);
  await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("s", expect.objectContaining({ payload: { operation: "resetCard.consume", arguments: { confirmed: true } }, precondition: { nativeThreadId: "thread", executionSegmentId: "segment", threadControlVersion: 4, projectLeaseVersion: 2, expectedActiveTurnId: null } }));
});

it("unknown prior receipt blocks another mutation", () => {
  render(<CodexOperationsPanel session={session} commands={[{ id: "old", type: "codex.manage", createdAt: "now", state: "unknown" } as CommandReceipt]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText("Codex 工具与账号", { selector: "summary > span" }));
  expect((screen.getByRole("button", { name: "等待主机回执" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.command).not.toHaveBeenCalled();
});

it("experimental interfaces require opt-in and live settings carry the exact active turn", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "live" } as CommandReceipt });
  render(<CodexOperationsPanel session={{ ...session, activeTurnId: "active-turn" }} commands={[]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText("Codex 工具与账号", { selector: "summary > span" }));
  expect(screen.queryByRole("option", { name: "实验：调整当前任务设置" })).toBeNull();
  fireEvent.click(screen.getByLabelText("显示已验证的 Codex 实验接口"));
  fireEvent.change(screen.getByLabelText("操作"), { target: { value: "turn.settings" } });
  fireEvent.change(screen.getByLabelText("模型名称（留空不改）"), { target: { value: "advertised-model" } });
  fireEvent.click(screen.getByLabelText("确认在此宿主机执行所选操作"));
  fireEvent.click(screen.getByRole("button", { name: "实验：调整当前任务设置" }));
  await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("s", expect.objectContaining({ payload: { operation: "turn.settings", arguments: { model: "advertised-model", confirmed: true, experimental: true } }, precondition: expect.objectContaining({ expectedActiveTurnId: "active-turn" }) }));
});


it("fork range requires a native task and preserves the exact target in the request", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "fork" } as CommandReceipt });
  const target = { ...session, title: "source", actions: { ...session.actions, fork: { allowed: true } } } as FleetSession;
  const view = render(<NativeSessionActions session={target} pending={false} onChanged={vi.fn()} request={{ action: "fork", args: "", nonce: 1 }} />);
  fireEvent.change(screen.getByLabelText("分支历史范围"), { target: { value: "before" } });
  const button = screen.getByRole("button", { name: "确认从当前历史创建分支" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("原生任务 Turn ID"), { target: { value: "task-boundary" } });
  fireEvent.click(button);
  await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("s", expect.objectContaining({ type: "thread.fork", payload: { beforeTurnId: "task-boundary" }, precondition: expect.objectContaining({ nativeThreadId: "thread", expectedActiveTurnId: null }) }));
  view.rerender(<NativeSessionActions session={{ ...target, id: "another", actions: { fork: { allowed: true } } } as FleetSession} pending={false} onChanged={vi.fn()} request={{ action: "fork", args: "", nonce: 2 }} />);
  expect(screen.queryByLabelText("原生任务 Turn ID")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认从当前历史创建分支" }));
  await waitFor(() => expect(api.command).toHaveBeenCalledTimes(2));
  expect(api.command).toHaveBeenLastCalledWith("another", expect.objectContaining({ payload: {} }));
});


it("goal management defaults to paused and has no autonomous activation option", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "goal" } as CommandReceipt });
  render(<CodexOperationsPanel session={session} commands={[]} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByText("Codex 工具与账号", { selector: "summary > span" }));
  fireEvent.change(screen.getByLabelText("操作"), { target: { value: "goal.set" } });
  expect((screen.getByLabelText("目标状态") as HTMLSelectElement).value).toBe("paused");
  expect(screen.queryByRole("option", { name: "进行中" })).toBeNull();
  fireEvent.change(screen.getByLabelText("目标内容（可留空保留原目标）"), { target: { value: "Verify the project" } });
  fireEvent.click(screen.getByRole("button", { name: "设置或调整目标" }));
  await waitFor(() => expect(api.command).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("s", expect.objectContaining({ payload: { operation: "goal.set", arguments: { objective: "Verify the project", status: "paused" } } }));
});

it("host account management needs only a host and preserves explicit confirmation", async () => {
 const machine={id:"host",reachability:"live",maintenanceCapabilities:["codex.host"]} as Machine;
 vi.mocked(api.hostCodexOperation).mockResolvedValue({id:"host-result",type:"codex.host",state:"accepted"} as HostOperation);
 render(<CodexOperationsPanel machine={machine} onChanged={vi.fn()}/>);
 fireEvent.click(screen.getByText("Codex 工具与账号",{selector:"summary > span"}));
 expect(screen.queryByRole("option",{name:"当前会话"})).toBeNull();
 expect(screen.queryByRole("option",{name:"查看目标与预算进度"})).toBeNull();
 expect(api.hostCodexOperation).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("操作"),{target:{value:"account.logout"}});
 expect((screen.getByRole("button",{name:"退出原生账号"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText("确认在此宿主机执行所选操作"));
 fireEvent.click(screen.getByRole("button",{name:"退出原生账号"}));
 await waitFor(()=>expect(api.hostCodexOperation).toHaveBeenCalledWith("host",{operation:"account.logout",arguments:{confirmed:true}},expect.any(String)));
 expect(api.command).not.toHaveBeenCalled();
});
