// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  await screen.findByRole("option", { name: "repo · 主目录 · /repo" });
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
  expect(screen.getByRole("option", { name: "repo · 主目录 · /repo" })).toBeTruthy();
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
  await screen.findByRole("option", { name: "first · 主目录 · /first" });
  expect(api.projects).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "无需等待所有页面" } });
  fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "first", "无需等待所有页面", undefined));
});


it("existing worktree entry keeps its project selected even outside the dashboard and creates there without another worktree", async () => {
  const main = { id: "main", machineId: "m", alias: "repo", pathHint: "/repo" } as Project;
  const lane = { ...main, id: "lane", alias: "repo-feature", pathHint: "/repo.worktrees/feature", repoRoot: "/repo", parentProjectId: "main" };
  const machine = { id: "m", name: "host", reachability: "live", compatibility: "compatible", identity: "paired", projects: [main] } as Machine;
  vi.spyOn(api, "projects").mockResolvedValue({ items: [main], nextCursor: null });
  const create = vi.fn().mockResolvedValue(undefined);
  render(<CreateSessionDialog open machines={[machine]} initialProject={lane} onClose={vi.fn()} onCreate={create} onToast={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole("combobox", {name: "项目"}) as HTMLSelectElement).value).toBe("lane"));
  expect((screen.getByRole("checkbox", {name: "使用独立工作目录（新建工作树）"}) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText("会话名称"), {target: {value: "继续工作树开发"}});
  fireEvent.click(screen.getByRole("button", {name: "创建会话"}));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "lane", "继续工作树开发", undefined));
});


it("filters every catalog page by provider, deduplicates overlapping pages and labels the real worktree", async () => {
  const main = { id: "codex-main", machineId: "m", alias: "repo", pathHint: "/repo", provider: "codex" } as Project;
  const other = ["claude", "cursor", "grok"].map(provider => ({...main, id: provider, provider} as Project));
  const lane = {...main, id: "lane", alias: "repo-feature", pathHint: "/repo.worktrees/feature", repoRoot: "/repo", gitBranch: "feat/feature", parentProjectId: main.id};
  const machine = {id: "m", name: "host", reachability: "live", compatibility: "compatible", identity: "paired", projects: [main, ...other]} as Machine;
  vi.spyOn(api, "projects").mockImplementation(async ({cursor}) => cursor ? {items: [main, lane], nextCursor: null} : {items: [main, ...other], nextCursor: "next"});
  const create = vi.fn().mockResolvedValue(undefined);
  render(<CreateSessionDialog open provider="codex" machines={[machine]} onClose={vi.fn()} onCreate={create} onToast={vi.fn()} />);
  await screen.findByRole("option", {name: "repo-feature · 工作树 · feat/feature · /repo.worktrees/feature"});
  expect(screen.getAllByRole("option", {name: "repo · 主目录 · /repo"})).toHaveLength(1);
  expect(Array.from((screen.getByLabelText("项目") as HTMLSelectElement).options).map(option => option.value)).toEqual([main.id, lane.id]);
  expect(api.projects).toHaveBeenCalledWith({machineId: "m", provider: "codex", limit: 100}, expect.any(AbortSignal));
  expect(api.projects).toHaveBeenCalledWith({machineId: "m", provider: "codex", limit: 100, cursor: "next"}, expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText("项目"), {target: {value: lane.id}});
  fireEvent.change(screen.getByLabelText("会话名称"), {target: {value: "在工作树开发"}});
  fireEvent.click(screen.getByRole("button", {name: "创建会话"}));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", lane.id, "在工作树开发", undefined));
});

it("switching providers cancels the old catalog and never restores its late results", async () => {
  const codex = {id: "codex", machineId: "m", alias: "repo", pathHint: "/repo", provider: "codex"} as Project;
  const claude = {...codex, id: "claude", provider: "claude" as const};
  const machine = {id: "m", name: "host", reachability: "live", compatibility: "compatible", identity: "paired", projects: [codex, claude]} as Machine;
  let resolve!: (page: {items: Project[]; nextCursor: null}) => void;
  const slow = new Promise<{items: Project[]; nextCursor: null}>(done => {resolve = done;});
  vi.spyOn(api, "projects").mockImplementation(async ({provider}) => provider === "codex" ? slow : {items: [claude], nextCursor: null});
  const create = vi.fn().mockResolvedValue(undefined);
  const props = {open: true, machines: [machine], onClose: vi.fn(), onCreate: create, onToast: vi.fn()};
  const view = render(<CreateSessionDialog {...props} provider="codex" />);
  await waitFor(() => expect(api.projects).toHaveBeenCalled());
  const oldSignal = vi.mocked(api.projects).mock.calls[0]![1]!;
  view.rerender(<CreateSessionDialog {...props} provider="claude" />);
  await waitFor(() => expect((screen.getByLabelText("项目") as HTMLSelectElement).value).toBe("claude"));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolve({items: [codex], nextCursor: null}));
  expect((screen.getByLabelText("项目") as HTMLSelectElement).value).toBe("claude");
  expect(screen.getAllByRole("option", {name: "repo · 主目录 · /repo"})).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("会话名称"), {target: {value: "Claude 开发"}});
  fireEvent.click(screen.getByRole("button", {name: "创建会话"}));
  await waitFor(() => expect(create).toHaveBeenCalledWith("m", "claude", "Claude 开发", undefined));
});
