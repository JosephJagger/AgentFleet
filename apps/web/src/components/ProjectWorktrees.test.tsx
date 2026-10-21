// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { startLaneSession } from "../lib/worktrees";
import { ProjectWorktreesPanel } from "./ProjectWorktrees";
import type { Machine, WorktreeOverview } from "../lib/types";
vi.mock("../lib/api", () => ({ api: { worktrees: vi.fn() } }));
vi.mock("../lib/worktrees", () => ({ startLaneSession: vi.fn(), waitForOperation: vi.fn() }));
afterEach(cleanup);
const overview: WorktreeOverview = {
  project: { projectId: "p", machineId: "m", alias: "app", root: "/repo", provider: "claude" },
  current: "main", branches: ["main"], mainDirtyFiles: 0, setupScript: false, customBranchNames: true, overlaps: [],
  lanes: [{ path: "/lane", branch: "feat/old", base: "main", exists: true, dirtyFiles: 0, ahead: 0, behind: 0, changedFiles: [], lastCommit: "", projects: [{ projectId: "lane-p", provider: "claude", alias: "lane" }], sessions: [{ id: "saved", projectId: "lane-p", provider: "claude", title: "原有历史", executionState: "idle", running: false, updatedAt: "" }] }],
  unmanaged: [{ path: "/external", branch: "external" }],
};
const machine = { agentRuntimes: { claude: { installed: true } } } as Machine;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.worktrees).mockResolvedValue(overview); vi.mocked(startLaneSession).mockResolvedValue({ sessionId: "created", laneProjectId: "lane-p", branch: "feat/new", setup: undefined }); });
it("defaults to the current provider, preserves the source session and sends the complete new branch name", async () => {
  const open = vi.fn();
  render(<ProjectWorktreesPanel projectId="p" machine={machine} currentSession={{ id: "source", title: "老会话", provider: "claude" }} onOpenSession={open} />);
  await screen.findByText("当前会话：老会话");
  expect((screen.getByRole("combobox", { name: "新会话的智能体" }) as HTMLSelectElement).value).toBe("claude");
  expect(screen.getByText(/不会自动继承对话上下文/)).toBeTruthy();
  expect(screen.queryByText("external")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "feat/new" } });
  fireEvent.click(screen.getByRole("button", { name: "创建工作树和新会话" }));
  await waitFor(() => expect(startLaneSession).toHaveBeenCalledWith("p", "m", { provider: "claude", branch: "feat/new", base: "main", setup: false }, expect.any(String)));
  expect(open).toHaveBeenCalledWith("created");
});
it("opening a listed session navigates to its history without creating another session", async () => {
  const open = vi.fn();
  render(<ProjectWorktreesPanel projectId="lane-p" machine={machine} currentSession={{ id: "saved", title: "原有历史", provider: "claude" }} onOpenSession={open} />);
  await screen.findByText("当前分支：feat/old");
  fireEvent.click(screen.getByRole("button", { name: "使用已有工作树（2）" }));
  fireEvent.click(screen.getByRole("button", { name: "打开会话：Claude Code · 原有历史" }));
  expect(open).toHaveBeenCalledWith("saved");
  expect(startLaneSession).not.toHaveBeenCalled();
  expect(screen.getByText("查看改动、合并或删除").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "在此新建 Claude Code 会话" }));
  await waitFor(() => expect(startLaneSession).toHaveBeenCalledWith("p", "m", { provider: "claude", adoptPath: "/external", setup: false }, expect.any(String)));
});
