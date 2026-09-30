import { SessionAppServer } from "./session-app-server.js";
import { ClaudeRuntime, isClaudeThread } from "./claude-runtime.js";
import type { AppServerCallbacks, AppServerClient, ThreadListPage } from "./app-server.js";
import { AgentError } from "./errors.js";
import { isRecord } from "./util.js";

/** Codex keeps its original client and defaults. Claude identities occupy a separate namespace. */
export function createMultiRuntime(callbacks: AppServerCallbacks): AppServerClient {
  const codex = new SessionAppServer(callbacks);
  const claude = new ClaudeRuntime(callbacks, codex.appServerEpoch);
  const routed = new Set(["createThread", "readThread", "readHistoryPage", "readTurnOutcome", "resumeThread", "unsubscribeThread", "startTurn", "steerTurn", "interruptTurn", "respondApproval", "respondInput", "threadAction", "startNativeTurn", "inspectEnvironment", "previewDeletion", "deleteThread", "stopBackgroundTerminals"]);
  let lastClaudeCatalog: Awaited<ReturnType<ClaudeRuntime["listThreads"]>> = [];
  const claudeCatalog = async () => { try { lastClaudeCatalog = await claude.listThreads(); delete claude.availability.error; } catch { claude.availability.error = "Claude 会话扫描失败，将自动重试"; } return lastClaudeCatalog; };
  const status = () => { void claude.refreshMetadata(); return { codex: { installed: true }, claude: claude.availability }; };
  return new Proxy(codex, {
    get(target, key) {
      if (key === "getAgentRuntimes") return status;
      if (key === "start") return async () => { await codex.start(); await claude.start(); };
      if (key === "refreshQuota") return async () => { await Promise.all([codex.refreshQuota?.(),claude.refreshMetadata()]); };
      if (key === "stop") return async () => { await Promise.all([codex.stop(), claude.stop()]); };
      if (key === "listThreads") return async () => [...await codex.listThreads(), ...await claudeCatalog()];
      if (key === "listThreadPage") return async (cursor: string | null, options?: { useStateDbOnly: boolean }): Promise<ThreadListPage> => {
        if (cursor === "claude:catalog") return { threads: await claudeCatalog(), nextCursor: null };
        const page = await codex.listThreadPage(cursor, options);
        return page.nextCursor ? page : { ...page, nextCursor: "claude:catalog" };
      };
      if (typeof key === "string" && routed.has(key)) return (...args: unknown[]) => {
        const first = args[0];
        const claudeTarget = typeof first === "string" ? isClaudeThread(first) || (typeof args[1] === "string" && isClaudeThread(args[1])) : isRecord(first) && (first.provider === "claude" || typeof first.nativeThreadId === "string" && isClaudeThread(first.nativeThreadId));
        const selected = claudeTarget ? claude : target;
        const method = Reflect.get(selected, key);
        if (typeof method !== "function") throw new AgentError("AGENT_CAPABILITY_UNAVAILABLE", "当前 Agent 不支持此操作");
        return Reflect.apply(method, selected, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
