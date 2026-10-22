// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceCatalog } from "./components/WorkspaceCatalog";
import { api } from "./lib/api";
import type { FleetSession, Page, Project } from "./lib/types";

vi.mock("./lib/api", () => ({ api: { projects: vi.fn(), sessions: vi.fn() } }));
const project: Project = { id: "p", machineId: "m", alias: "测试项目", pathHint: "/srv/test", syncContent: true, retentionDays: 7 };
const row = (id: string) => ({ id, title: `会话 ${id}`, machineName: "主机", projectAlias: "测试项目", lastActivityAt: "2026-09-05T00:00:00Z", state: { reachability: "live", history: "complete" } } as FleetSession);
const props = { machineId: "m", onSelect: vi.fn(), onCreate: vi.fn() };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.projects).mockResolvedValue({ items: [project], nextCursor: null });
  vi.mocked(api.sessions).mockResolvedValue({ items: [row("1")], nextCursor: null });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("项目列表提供独立的新项目入口", async () => {
  const onCreateProject = vi.fn();
  render(<WorkspaceCatalog {...props} refreshKey="create-project" onCreateProject={onCreateProject} />);
  fireEvent.click(screen.getByRole("button", { name: "新项目" }));
  expect(onCreateProject).toHaveBeenCalledOnce();
});

it("项目分页在左侧显示总页数并通过前后按钮翻页", async () => {
  vi.mocked(api.projects).mockImplementation(async ({ offset }) => ({
    items: [{ ...project, id: offset === 8 ? "p-9" : "p-1", alias: offset === 8 ? "第九个项目" : "第一个项目" }],
    nextCursor: offset === 32 ? null : "next",
    total: 40,
  }));
  render(<WorkspaceCatalog {...props} refreshKey="pages" />);
  await screen.findByRole("navigation", { name: "项目分页" });
  expect(screen.getByText("第 1 / 5 页")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "第 1 页" })).toBeNull();
  expect(screen.getAllByRole("button", { name: /上一页|下一页/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第九个项目");
  expect(screen.getByText("第 2 / 5 页")).toBeTruthy();
  expect(api.projects).toHaveBeenLastCalledWith({ machineId: "m", provider: "codex", offset: 8, limit: 8, groupWorktrees: true }, expect.any(AbortSignal));
});

it("后台刷新不插入加载行，保留已有项目和会话 DOM", async () => {
  const { rerender, container } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目.*\/srv/ }));
  const original = await screen.findByText("会话 1");
  const pending = deferred<Page<FleetSession>>();
  vi.mocked(api.sessions).mockReturnValue(pending.promise);
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  expect(container.querySelectorAll(".catalog-loading").length).toBe(0);
  expect(screen.getByText("会话 1")).toBe(original);
  await act(async () => pending.resolve({ items: [row("1")], nextCursor: null }));
  expect(screen.getByText("会话 1")).toBe(original);
});

it("后台刷新保留所有已加载页，较晚页失败也不提交半份列表", async () => {
  vi.mocked(api.sessions).mockImplementation(async ({ cursor }) => cursor ? { items: [row("31")], nextCursor: null } : { items: Array.from({ length: 30 }, (_, i) => row(String(i + 1))), nextCursor: "page-2" });
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目.*\/srv/ }));
  await screen.findByText("会话 1");
  for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("会话 31");
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(5));
  expect(screen.getByText("会话 31")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多会话" })).toBeNull();
  vi.mocked(api.sessions).mockImplementation(async ({ cursor }) => {
    if (cursor) throw new Error("网络暂时不可用");
    return { items: [row("new")], nextCursor: "page-2" };
  });
  rerender(<WorkspaceCatalog {...props} refreshKey="3" />);
  await screen.findByText("网络暂时不可用");
  expect(screen.queryByText("会话 1")).toBeNull();
  expect(screen.getByText("会话 31")).toBeTruthy();
  expect(screen.queryByText("会话 new")).toBeNull();
});

it("空项目后台刷新时空状态不消失", async () => {
  vi.mocked(api.projects).mockResolvedValue({ items: [], nextCursor: null });
  const { rerender, container } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  const empty = await screen.findByText(/暂无项目/);
  vi.mocked(api.projects).mockReturnValue(new Promise(() => undefined));
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.projects).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/暂无项目/)).toBe(empty);
  expect(container.querySelector(".catalog-loading")).toBeNull();
});

it("项目刷新失败不会卸载已展开的会话", async () => {
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目.*\/srv/ }));
  const original = await screen.findByText("会话 1");
  vi.mocked(api.projects).mockRejectedValue(new Error("项目请求失败"));
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await screen.findByText("项目请求失败");
  expect(screen.getByText("会话 1")).toBe(original);
});

it("已取消的慢刷新不会覆盖最新会话", async () => {
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目.*\/srv/ }));
  await screen.findByText("会话 1");
  const pending = deferred<Page<FleetSession>>();
  vi.mocked(api.sessions).mockReturnValueOnce(pending.promise);
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  vi.mocked(api.sessions).mockResolvedValue({ items: [row("latest")], nextCursor: null });
  rerender(<WorkspaceCatalog {...props} refreshKey="3" />);
  await screen.findByText("会话 latest");
  await act(async () => pending.resolve({ items: [row("stale")], nextCursor: null }));
  expect(screen.getByText("会话 latest")).toBeTruthy();
  expect(screen.queryByText("会话 stale")).toBeNull();
});

it("会话行在历史标记右侧展示独立 token 数，并区分零和未记录", async () => {
  vi.mocked(api.sessions).mockResolvedValue({ items: [{...row("used"),recordedTokens:1200},{...row("zero"),recordedTokens:0},row("missing")], nextCursor:null });
  const {container}=render(<WorkspaceCatalog {...props} refreshKey="usage" />);
  fireEvent.click(await screen.findByRole("button",{name:/测试项目.*\/srv/}));
  await screen.findByText("会话 used");
  const labels=container.querySelectorAll(".session-row__tokens");
  expect(labels).toHaveLength(3);
  expect(labels[0].getAttribute("title")).toBe("总消耗 1,200 tokens · 本周消耗 — tokens");
  expect(labels[0].previousElementSibling?.className).toBe("history-mark");
  expect(labels[1].textContent).toBe("累计 0 · 本周 — tokens");
  expect(labels[2].textContent).toBe("累计 — · 本周 — tokens");
});

it("切换 Agent 重新加载独立项目目录", async () => {
  vi.mocked(api.projects).mockImplementation(async options => ({ items: [{...project, id: options.provider === "claude" ? "claude-p" : "codex-p", alias: options.provider === "claude" ? "Claude 项目" : "Codex 项目"}],nextCursor:null }));
  const view = render(<WorkspaceCatalog {...props} provider="codex" refreshKey="agents" />);
  await screen.findByText("Codex 项目");
  view.rerender(<WorkspaceCatalog {...props} provider="claude" refreshKey="agents" />);
  await screen.findByText("Claude 项目");
  expect(screen.queryByText("Codex 项目")).toBeNull();
  expect(api.projects).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "claude", offset: 0 }), expect.any(AbortSignal));
});

it("工作树嵌套在项目中，折叠后仍显示运行状态，创建会话使用工作树项目", async () => {
  const child: Project = { ...project, id: "lane", alias: "测试项目-seo", pathHint: "/srv/.test.worktrees/seo", repoRoot: project.pathHint, gitBranch: "feat/seo", parentProjectId: project.id, activity: { running: 1, waiting: 0, uncertain: 0 } };
  vi.mocked(api.projects).mockResolvedValue({ items: [child, project], nextCursor: null, total: 1 });
  const view = render(<WorkspaceCatalog {...props} refreshKey="tree" />);
  const parent = await screen.findByRole("button", { name: /测试项目.*\/srv/ });
  expect(screen.getByText("执行中 1")).toBeTruthy();
  expect(screen.queryByText("seo")).toBeNull();
  fireEvent.click(parent);
  fireEvent.click(screen.getByRole("button", { name: /^工作树 · 1/ }));
  const lane = screen.getByRole("button", { name: /seo 工作树.*分支：feat\/seo/ });
  expect(lane.closest(".catalog-worktrees-list")).toBeTruthy();
  expect(view.container.querySelectorAll(".workspace-catalog > .project-session-group")).toHaveLength(1);
  fireEvent.click(lane);
  fireEvent.click(await screen.findByRole("button", { name: "在 测试项目-seo 新建会话" }));
  expect(props.onCreate).toHaveBeenCalledWith(child);
  fireEvent.click(screen.getByRole("button", { name: /^工作树 · 1/ }));
  view.unmount();
  render(<WorkspaceCatalog {...props} refreshKey="remount" />);
  expect((await screen.findByRole("button", { name: /测试项目.*\/srv/ })).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^工作树 · 1/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("seo")).toBeNull();
});

it("选中工作树会话展开归属位置，刷新不重新打开手动收起的工作树", async () => {
  const child: Project = { ...project, id: "lane", alias: "测试项目-seo", pathHint: "/srv/seo", repoRoot: project.pathHint, parentProjectId: project.id };
  vi.mocked(api.projects).mockResolvedValue({ items: [project, child], nextCursor: null, total: 1 });
  const selected = { ...row("selected"), machineId: "m", projectId: "lane", provider: "codex" as const };
  vi.mocked(api.sessions).mockImplementation(async ({ projectId }) => ({ items: projectId === "lane" ? [selected] : [], nextCursor: null }));
  const view = render(<WorkspaceCatalog {...props} selectedSession={selected} refreshKey="one" />);
  await screen.findByText("会话 selected");
  fireEvent.click(screen.getByRole("button", { name: /^工作树 · 1/ }));
  view.rerender(<WorkspaceCatalog {...props} selectedSession={selected} refreshKey="two" />);
  await waitFor(() => expect(api.projects).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: /^工作树 · 1/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("会话 selected")).toBeNull();
  view.unmount();
  render(<WorkspaceCatalog {...props} selectedSession={selected} refreshKey="reloaded" />);
  await screen.findByRole("button", { name: /^工作树 · 1/ });
  expect(screen.getByRole("button", { name: /^工作树 · 1/ }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("会话 selected")).toBeNull();
});


it("主目录每页五条，支持按钮和左右滑动，并忽略纵向滚动与多指手势", async () => {
  vi.mocked(api.sessions).mockResolvedValue({ items: Array.from({ length: 12 }, (_, i) => row(String(i + 1))), nextCursor: null });
  const { container, rerender } = render(<WorkspaceCatalog {...props} refreshKey="pages" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目.*\/srv/ }));
  await screen.findByText("会话 1");
  expect(container.querySelectorAll(".session-row")).toHaveLength(5);
  expect(screen.queryByText("会话 6")).toBeNull();
  expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("会话 6")).toBeTruthy();
  const area = container.querySelector(".catalog-main-session-pages")!;
  const swipe = (x: number, y: number) => {
    fireEvent.touchStart(area, { touches: [{ clientX: 150, clientY: 100 }] });
    fireEvent.touchMove(area, { touches: [{ clientX: x, clientY: y }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: x, clientY: y }] });
  };
  swipe(50, 200);
  expect(screen.getByText("会话 6")).toBeTruthy();
  fireEvent.touchStart(area, { touches: [{ clientX: 150, clientY: 100 }, { clientX: 180, clientY: 100 }] });
  fireEvent.touchEnd(area, { changedTouches: [{ clientX: 50, clientY: 100 }] });
  expect(screen.getByText("会话 6")).toBeTruthy();
  swipe(50, 100);
  expect(screen.getByText("第 3 / 3 页")).toBeTruthy();
  expect(container.querySelectorAll(".session-row")).toHaveLength(2);
  expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("会话 11"), { detail: 1 });
  expect(props.onSelect).not.toHaveBeenCalled();
  swipe(250, 100);
  expect(screen.getByText("会话 6")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  expect(screen.getByText("会话 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  vi.mocked(api.sessions).mockResolvedValue({ items: [row("1")], nextCursor: null });
  rerender(<WorkspaceCatalog {...props} refreshKey="shrunk" />);
  await screen.findByText("会话 1");
  expect(screen.queryByRole("navigation", { name: "会话分页" })).toBeNull();
});
