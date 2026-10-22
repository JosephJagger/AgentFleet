// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { startLaneSession, waitForOperation } from "./worktrees";
import type { HostOperation } from "./types";
vi.mock("./api", () => ({ api: { createWorktree: vi.fn(), projects: vi.fn(), createSession: vi.fn(), readHostOperation: vi.fn() } }));
vi.mock("../i18n", () => ({ t: (text: string) => text }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
it("failed setup preserves the lane and reports output without creating or opening a session", async () => {
  vi.mocked(api.createWorktree).mockResolvedValue({ state: "succeeded", result: { canonicalRoot: "/repo/lane", setup: { ran: true, ok: false, output: "dependency install failed" } } } as never);
  await expect(startLaneSession("p", "m", { provider: "codex", name: "lane", setup: true }, "task")).rejects.toThrow("dependency install failed");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.projects).not.toHaveBeenCalled();
});
it("successful setup opens the selected provider's lane, including Windows directories", async () => {
  vi.mocked(api.createWorktree).mockResolvedValue({ state: "succeeded", result: { canonicalRoot: "C:\\repo\\lane", setup: { ran: true, ok: true } } } as never);
  vi.mocked(api.projects).mockResolvedValue({ items: [{ id: "lane-id", pathHint: "C:\\repo\\lane", provider: "claude" }] } as never);
  vi.mocked(api.createSession).mockResolvedValue({ session: { id: "new-session" } } as never);
  const result = await startLaneSession("p", "m", { provider: "claude", name: "lane", setup: true }, "task");
  expect(result.sessionId).toBe("new-session");
  expect(api.projects).toHaveBeenCalledWith({ machineId: "m", q: "lane", limit: 100 });
});

it.each([true, false])("opens the registered worktree directly when projectId is available: %s", async (registered) => {
  vi.mocked(api.createWorktree).mockResolvedValue({ state: "succeeded", result: {
    canonicalRoot: "/repo/worktrees/task", branch: "task", ...(registered ? { projectId: "lane-project" } : {}),
  } } as never);
  vi.mocked(api.projects).mockResolvedValue({ items: [
    { id: "lane-project", pathHint: "/repo/worktrees/task", provider: "codex" },
  ], nextCursor: null } as never);
  vi.mocked(api.createSession).mockResolvedValue({ session: { id: "new-session" } } as never);
  const result = await startLaneSession("source", "machine", { provider: "codex", setup: false }, "task");
  expect(result.sessionId).toBe("new-session");
  expect(api.createSession).toHaveBeenCalledWith("machine", "lane-project", "task");
  expect(api.projects).toHaveBeenCalledTimes(registered ? 0 : 1);
});

const accepted: HostOperation = { id: "operation", type: "worktree.create", state: "accepted", createdAt: "", updatedAt: "" };

it("observes quick operation completion at the first short poll", async () => {
  vi.useFakeTimers();
  const completed = { ...accepted, state: "succeeded" as const };
  vi.mocked(api.readHostOperation).mockResolvedValue(completed);
  const result = waitForOperation(accepted);
  await vi.advanceTimersByTimeAsync(149);
  expect(api.readHostOperation).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual(completed);
  expect(api.readHostOperation).toHaveBeenCalledOnce();
});

it("backs off short startup polls to the existing steady interval for long operations", async () => {
  vi.useFakeTimers();
  vi.mocked(api.readHostOperation).mockResolvedValue(accepted);
  const result = waitForOperation(accepted);
  for (const [delay, count] of [[150, 1], [300, 2], [600, 3], [800, 4], [800, 5]]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(api.readHostOperation).toHaveBeenCalledTimes(count - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.readHostOperation).toHaveBeenCalledTimes(count);
  }
  vi.mocked(api.readHostOperation).mockResolvedValue({ ...accepted, state: "succeeded" });
  await vi.advanceTimersByTimeAsync(800);
  expect((await result).state).toBe("succeeded");
});

it("stops at the deadline instead of oversleeping or reading again", async () => {
  vi.useFakeTimers();
  vi.mocked(api.readHostOperation).mockResolvedValue(accepted);
  const rejected = expect(waitForOperation(accepted, 200)).rejects.toThrow("主机仍在处理");
  await vi.advanceTimersByTimeAsync(200);
  await rejected;
  expect(api.readHostOperation).toHaveBeenCalledOnce();
});
