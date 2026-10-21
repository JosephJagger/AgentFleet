// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { startLaneSession } from "./worktrees";
vi.mock("./api", () => ({ api: { createWorktree: vi.fn(), readHostOperation: vi.fn(), projects: vi.fn(), sessions: vi.fn(), command: vi.fn(), createSession: vi.fn() } }));
const done = (result: Record<string, unknown>) => ({ id: "op", type: "worktree.create", state: "succeeded", createdAt: "", updatedAt: "", result }) as never;
const session = (ownership: string) => ({ id: "copy", nativeThreadId: "fork-1", threadControlVersion: 3, projectLeaseVersion: 5, state: { ownership } }) as never;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.projects).mockResolvedValue({ items: [{ id: "lane-codex", provider: "codex", pathHint: "/srv/.app.worktrees/copy" }], nextCursor: null, total: 1 } as never);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("a copied conversation is taken over in the lane and opened instead of creating a blank session", async () => {
  vi.mocked(api.createWorktree).mockResolvedValue(done({ canonicalRoot: "/srv/.app.worktrees/copy", branch: "feat/copy", forkedNativeThreadId: "fork-1" }));
  let polls = 0;
  vi.mocked(api.sessions).mockImplementation(async () => ({ items: [session(++polls < 4 ? "claimable" : "agentfleet_owned")], nextCursor: null }) as never);
  vi.mocked(api.command).mockResolvedValue({ command: {} } as never);
  const started = startLaneSession("main", "m", { provider: "codex", branch: "feat/copy", forkSessionId: "source", setup: false }, "x");
  await vi.runAllTimersAsync();
  expect(await started).toMatchObject({ sessionId: "copy", laneProjectId: "lane-codex", forked: true, claimed: true, branch: "feat/copy" });
  expect(vi.mocked(api.createWorktree).mock.calls[0]![1]).toMatchObject({ provider: "codex", forkSessionId: "source" });
  expect(api.command).toHaveBeenCalledWith("copy", expect.objectContaining({ type: "thread.claim", precondition: { nativeThreadId: "fork-1", threadControlVersion: 3, expectedActiveTurnId: null, projectLeaseVersion: 5 } }));
  expect(api.createSession).not.toHaveBeenCalled();
});

it("a host that did not copy the session is reported instead of silently opening a blank one", async () => {
  vi.mocked(api.createWorktree).mockResolvedValue(done({ canonicalRoot: "/srv/.app.worktrees/copy", branch: "feat/copy" }));
  const started = startLaneSession("main", "m", { provider: "codex", forkSessionId: "source", setup: false }, "x");
  const failure = expect(started).rejects.toThrow(/没有复制会话/);
  await vi.runAllTimersAsync();
  await failure;
  expect(api.createSession).not.toHaveBeenCalled();
});

it("a blank lane session is still created for non-fork requests", async () => {
  vi.mocked(api.createWorktree).mockResolvedValue(done({ canonicalRoot: "/srv/.app.worktrees/copy", branch: "af/x" }));
  vi.mocked(api.createSession).mockResolvedValue({ session: { id: "blank" } } as never);
  const started = startLaneSession("main", "m", { provider: "codex", setup: false }, "title");
  await vi.runAllTimersAsync();
  expect(await started).toMatchObject({ sessionId: "blank", forked: false });
});
