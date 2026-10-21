// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { laneProviders, ProjectWorktreesPanel } from "./components/ProjectWorktrees";
import type { HostOperation, Machine, WorktreeOverview } from "./lib/types";
const mocks = vi.hoisted(() => ({ worktrees: vi.fn(), worktreeDiff: vi.fn(), createWorktree: vi.fn(), mergeWorktree: vi.fn(), removeWorktree: vi.fn(), readHostOperation: vi.fn(), projects: vi.fn(), createSession: vi.fn() }));
vi.mock("./lib/api", () => ({ api: mocks }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const machine = { id: "m", agentRuntimes: { claude: { installed: true, version: "1" }, grok: { installed: true } } } as unknown as Machine;
const overview: WorktreeOverview = {
  project: { projectId: "main", alias: "app", root: "/srv/app", provider: "codex", machineId: "m" },
  current: "main", branches: ["main", "af/login"], mainDirtyFiles: 0, setupScript: true,
  lanes: [{ path: "/srv/.app.worktrees/login", branch: "af/login", base: "main", exists: true, dirtyFiles: 0, ahead: 2, behind: 0, changedFiles: ["a.ts"], lastCommit: "fix login",
    projects: [{ projectId: "lane-codex", provider: "codex", alias: "app-login" }],
    sessions: [{ id: "s1", projectId: "lane-codex", provider: "codex", title: "登录修复", executionState: "idle", running: false, updatedAt: "" }] }],
  overlaps: [{ file: "a.ts", branches: ["af/login", "af/other"] }], unmanaged: [{ path: "/srv/desktop", branch: "codex/x" }],
};
const done = (result: Record<string, unknown>): HostOperation => ({ id: "op", type: "worktree.create", state: "succeeded", createdAt: "", updatedAt: "", result });

it("只列出主机上已安装的智能体", () => {
  expect(laneProviders(machine)).toEqual(["codex", "claude", "grok"]);
  expect(laneProviders(undefined)).toEqual(["codex"]);
});

it("显示工作树、重叠预警和外部工作树，并可打开已有会话", async () => {
  mocks.worktrees.mockResolvedValue(overview);
  const open = vi.fn();
  render(<ProjectWorktreesPanel projectId="main" machine={machine} onOpenSession={open} />);
  expect(await screen.findByText(/af\/login/, { selector: "strong" })).toBeTruthy();
  expect(screen.getByText(/领先 2 \/ 落后 0/)).toBeTruthy();
  expect(screen.getByText(/与其他工作树改动了相同文件：a\.ts/)).toBeTruthy();
  expect(screen.getByText("/srv/desktop")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /登录修复/ }));
  expect(open).toHaveBeenCalledWith("s1");
  expect((screen.getByRole("button", { name: "合并到 main" }) as HTMLButtonElement).disabled).toBe(false);
});

it("新建工作树后为所选智能体创建会话并打开", async () => {
  mocks.worktrees.mockResolvedValue({ ...overview, lanes: [], overlaps: [], unmanaged: [] });
  mocks.createWorktree.mockResolvedValue(done({ canonicalRoot: "/srv/.app.worktrees/api", branch: "af/api", setup: { ran: true, ok: true } }));
  mocks.projects.mockResolvedValue({ items: [{ id: "lane-claude", provider: "claude", pathHint: "/srv/.app.worktrees/api" }], nextCursor: null });
  mocks.createSession.mockResolvedValue({ session: { id: "new-session" } });
  const open = vi.fn();
  render(<ProjectWorktreesPanel projectId="main" machine={machine} onOpenSession={open} />);
  fireEvent.change(await screen.findByLabelText("智能体"), { target: { value: "claude" } });
  fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "api" } });
  fireEvent.click(screen.getByRole("button", { name: "新建工作树并开始会话" }));
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("new-session"));
  expect(mocks.createWorktree.mock.calls[0]![1]).toEqual({ provider: "claude", name: "api", base: "main", setup: true });
  expect(mocks.createSession).toHaveBeenCalledWith("m", "lane-claude", "Claude Code · 工作树");
});
