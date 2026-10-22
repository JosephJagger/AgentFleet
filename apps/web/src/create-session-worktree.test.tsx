// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreateSessionDialog } from "./App";
import { api } from "./lib/api";
import type { Machine, Project, WorktreeOverview } from "./lib/types";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("new-session worktrees carry the entered branch, source and explicit setup choice; reopening resets the draft", async () => {
  const project = { id: "p", machineId: "m", alias: "repo", pathHint: "/repo", provider: "claude" } as Project;
  const machine = { id: "m", name: "B52H", reachability: "live", compatibility: "compatible", identity: "paired", projects: [project] } as Machine;
  vi.spyOn(api, "projects").mockResolvedValue({ items: [project], nextCursor: null } as never);
  vi.spyOn(api, "worktrees").mockResolvedValue({ branches: ["main", "develop"], current: "main", setupScript: true, customBranchNames: true } as WorktreeOverview);
  const create = vi.fn().mockResolvedValue(undefined);
  const props = { machines: [machine], initialProject: project, onClose: vi.fn(), onCreate: create, onToast: vi.fn() };
  const view = render(<CreateSessionDialog open {...props} />);
  await screen.findByRole("option", { name: "repo · /repo" });
  fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "新的开发" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "使用独立工作目录（新建工作树）" }));
  await screen.findByRole("textbox", { name: /新分支名称/ });
  fireEvent.change(screen.getByRole("textbox", { name: /新分支名称/ }), { target: { value: "feat/custom-name" } });
  fireEvent.change(screen.getByRole("combobox", { name: /基础分支/ }), { target: { value: "develop" } });
  fireEvent.click(screen.getByRole("button", { name: "创建工作树和新会话" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "p", "新的开发", { provider: "claude", base: "develop", branch: "feat/custom-name", setup: false }));
  view.rerender(<CreateSessionDialog open={false} {...props} />);
  view.rerender(<CreateSessionDialog open {...props} />);
  expect((screen.getByRole("checkbox", { name: "使用独立工作目录（新建工作树）" }) as HTMLInputElement).checked).toBe(false);
});

it("can create from known projects while catalog requests are still pending", async () => {
  const project = { id: "known", machineId: "m", alias: "repo", pathHint: "/repo" } as Project;
  const machine = { id: "m", name: "host", reachability: "live", compatibility: "compatible", identity: "paired", projects: [project] } as Machine;
  vi.spyOn(api, "projects").mockImplementation(() => new Promise(() => {}));
  const create = vi.fn().mockResolvedValue(undefined);
  render(<CreateSessionDialog open machines={[machine]} onClose={vi.fn()} onCreate={create} onToast={vi.fn()} />);
  expect(screen.getByRole("option", { name: "repo · /repo" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "立即创建" } });
  fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "known", "立即创建", undefined));
});

it("shows the first catalog page before later pages finish loading", async () => {
  const project = { id: "first", machineId: "m", alias: "first", pathHint: "/first" } as Project;
  const machine = { id: "m", name: "host", reachability: "live", compatibility: "compatible", identity: "paired", projects: [] } as unknown as Machine;
  vi.spyOn(api, "projects").mockResolvedValueOnce({ items: [project], nextCursor: "page-2" })
    .mockImplementation(() => new Promise(() => {}));
  const create = vi.fn().mockResolvedValue(undefined);
  render(<CreateSessionDialog open machines={[machine]} onClose={vi.fn()} onCreate={create} onToast={vi.fn()} />);
  await screen.findByRole("option", { name: "first · /first" });
  expect(api.projects).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "无需等待所有页面" } });
  fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "first", "无需等待所有页面", undefined));
});
