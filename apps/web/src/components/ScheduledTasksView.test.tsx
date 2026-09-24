// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import type { FleetSession, Machine, ScheduledHistoryRun } from "../lib/types";
import { ScheduledTasksView } from "./ScheduledTasksView";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({ api: {
  scheduledTasks: vi.fn(), scheduledHistory: vi.fn(), sessions: vi.fn(), scheduledTask: vi.fn(),
} }));

const sessions = Array.from({ length: 20 }, (_, index) => ({
  id: `session-${index + 1}`, title: `session ${index + 1}`, machineId: "host-1", machineName: "Home",
  projectId: "project-1", projectAlias: "Demo", state: { ownership: "agentfleet_owned" },
} as FleetSession));
const machines = [{ id: "host-1", name: "Home", projects: [{ id: "project-1", alias: "Demo" }] }] as Machine[];
const history = [{ run_id: "run-1", task_id: "task-1", scheduled_at: "2026-09-24T08:00:00Z", status: "succeeded",
  session_id: "session-2", command_id: "command-1", detail: null, created_at: "2026-09-24T08:00:00Z", updated_at: "2026-09-24T08:00:00Z",
  title: "Daily check", project_id: "project-1", machine_id: "host-1" }] as ScheduledHistoryRun[];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("searches all controlled sessions before enabling task settings and keeps history inside scheduled tasks", async () => {
  setLocale("zh-CN");
  vi.mocked(api.scheduledTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.scheduledHistory).mockResolvedValue({ runs: history });
  vi.mocked(api.sessions).mockImplementation(async options => ({
    items: sessions.filter(session => !options.q || session.title.includes(options.q)), nextCursor: null, total: sessions.length,
  }));
  render(<ScheduledTasksView machines={machines} onSession={vi.fn()} onToast={vi.fn()} />);
  expect(screen.getByRole("textbox", { name: "任务名称" }).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "使用项目里的已有会话" }));
  const results = await screen.findByRole("listbox", { name: "选择已接管的会话" });
  await waitFor(() => expect(within(results).getAllByRole("option")).toHaveLength(20));
  fireEvent.click(within(results).getByRole("option", { name: /session 17/ }));
  expect(screen.getByRole("textbox", { name: "任务名称" }).matches(":disabled")).toBe(false);
  expect(screen.getByText(/session 17 · Home \/ Demo/)).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("搜索主机、项目或会话"), { target: { value: "session 2" } });
  await waitFor(() => expect(vi.mocked(api.sessions)).toHaveBeenLastCalledWith(expect.objectContaining({ managed: true, q: "session 2" }), expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
  expect(await screen.findByText("Daily check")).toBeTruthy();
});

it("searches host, project, and path before choosing a project for a new session", async () => {
  setLocale("zh-CN");
  vi.mocked(api.scheduledTasks).mockResolvedValue({ tasks: [] });
  vi.mocked(api.scheduledHistory).mockResolvedValue({ runs: [] });
  const manyProjects = [{ ...machines[0], projects: Array.from({ length: 20 }, (_, index) => ({
    id: `project-${index + 1}`, alias: index === 16 ? "Blog_规划" : `Project ${index + 1}`,
    pathHint: index === 16 ? "/work/blog" : `/work/project-${index + 1}`,
  })) }] as Machine[];
  render(<ScheduledTasksView machines={manyProjects} onSession={vi.fn()} onToast={vi.fn()} />);
  const results = screen.getByRole("listbox", { name: "选择项目" });
  expect(within(results).getAllByRole("option")).toHaveLength(20);
  expect(screen.getByRole("textbox", { name: "任务名称" }).matches(":disabled")).toBe(true);
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索项目" }), { target: { value: "blog" } });
  expect(within(results).getAllByRole("option")).toHaveLength(1);
  fireEvent.click(within(results).getByRole("option", { name: /Blog_规划/ }));
  expect(screen.getByRole("textbox", { name: "任务名称" }).matches(":disabled")).toBe(false);
  expect(screen.getByText(/已选项目 · Home \/ Blog_规划/)).toBeTruthy();
});
