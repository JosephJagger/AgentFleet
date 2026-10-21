import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { startLaneSession } from "./worktrees";
vi.mock("./api", () => ({ api: { createWorktree: vi.fn(), projects: vi.fn(), createSession: vi.fn() } }));
vi.mock("../i18n", () => ({ t: (text: string) => text }));
beforeEach(() => vi.clearAllMocks());
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
