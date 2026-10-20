import { AcpRuntime } from "./acp-runtime.js";
import { ACP_PROVIDER_IDS, isAcpProvider } from "./provider-catalog.js";
import { decodeProviderThread } from "./provider-identity.js";
import { SessionAppServer } from "./session-app-server.js";
import { ClaudeRuntime, isClaudeThread, detectClaude } from "./claude-runtime.js";
import type { AppServerCallbacks, AppServerClient, ThreadListPage } from "./app-server.js";
import { AgentError } from "./errors.js";
import { isRecord } from "./util.js";

/** Codex keeps its original client and defaults. Claude identities occupy a separate namespace. */
export function createMultiRuntime(callbacks: AppServerCallbacks, options: {codexReadable?: boolean; additionalAllowed?: boolean; detectClaude?: typeof detectClaude} = {}): AppServerClient {
  const codexReadable = options.codexReadable !== false;
  const codex = new SessionAppServer(callbacks);
  const claude = new ClaudeRuntime(callbacks, codex.appServerEpoch, options.detectClaude ? {detectClaude:options.detectClaude} : {});
  const additional = new Map((options.additionalAllowed === false ? [] : ACP_PROVIDER_IDS).map(id => [id, new AcpRuntime(id, callbacks, codex.appServerEpoch)]));
  let lastAdditionalCatalog: Awaited<ReturnType<AcpRuntime['listThreads']>> = [];
  let additionalScan: Promise<void> | undefined;
  let nextAdditionalScan = 0;
  const schedule = new Map<string, {next: number; delay: number}>();
  let stopped = false;
  // Slow or unavailable optional CLIs must not delay Codex/Claude discovery.
  const additionalCatalog = async () => {
    if(!stopped && !additionalScan && Date.now() >= nextAdditionalScan) {
      nextAdditionalScan = Date.now() + 60_000;
      additionalScan = Promise.all([...additional.values()].map(async runtime => {
        const known = () => lastAdditionalCatalog.filter(row => decodeProviderThread(row.nativeThreadId)?.provider === runtime.provider);
        const slot = schedule.get(runtime.provider) ?? {next: 0, delay: 60_000};
        // A failing CLI (not logged in, incompatible) must not be cold-started every minute.
        if (Date.now() < slot.next) return known();
        try { const rows = await runtime.listThreads(); schedule.set(runtime.provider, {next: 0, delay: 60_000}); return rows; }
        catch { const delay = Math.min(slot.delay * 2, 600_000); schedule.set(runtime.provider, {next: Date.now() + delay, delay}); return known().map(row => ({...row,executionState:'unknown' as const})); }
      })).then(rows => {
        const next=rows.flat();const changed=JSON.stringify(next)!==JSON.stringify(lastAdditionalCatalog);
        lastAdditionalCatalog=next;
        if(!stopped && changed)callbacks.onCatalogChanged?.(codex.appServerEpoch);
      }).finally(()=>{additionalScan=undefined;});
    }
    return lastAdditionalCatalog;
  };
  const routed = new Set(["manageGrok", "createThread", "readThread", "readHistoryPage", "readConversation", "readNativeSubagents", "readTurnOutcome", "resumeThread", "unsubscribeThread", "startTurn", "steerTurn", "interruptTurn", "respondApproval", "respondInput", "threadAction", "startNativeTurn", "inspectEnvironment", "previewDeletion", "deleteThread", "stopBackgroundTerminals"]);
  let lastClaudeCatalog: Awaited<ReturnType<ClaudeRuntime["listThreads"]>> = [];
  const claudeCatalog = async () => { try { lastClaudeCatalog = await claude.listThreads(); delete claude.availability.error; } catch { claude.availability.error = "Claude 会话扫描失败，将自动重试"; } return lastClaudeCatalog; };
  const status = () => { if(codexReadable) void claude.refreshMetadata(); return { codex: { installed: codexReadable }, claude: claude.availability, ...Object.fromEntries([...additional].map(([id,runtime]) => [id,runtime.availability])) }; };
  return new Proxy(codex, {
    get(target, key) {
      if (key === "refreshManagedClaude") return async () => { await claude.stop(); await claude.start(); if(!claude.availability.installed)throw new AgentError("CLAUDE_ACTIVATION_FAILED","Claude runtime is not available"); };
      if (key === "getAgentRuntimes") return status;
      if (key === "start") return async () => { if(codexReadable) {await codex.start(); await claude.start();} if(codexReadable) {void Promise.all([...additional.values()].map(runtime => runtime.start()));} else await Promise.all([...additional.values()].map(runtime => runtime.start())); };
      if (key === "refreshQuota") return async () => { if(codexReadable) await Promise.all([codex.refreshQuota?.(),claude.refreshMetadata()]); };
      if (key === "stop") return async () => { stopped=true; await Promise.all([codex.stop(), claude.stop(), ...[...additional.values()].map(runtime => runtime.stop())]); };
      if (key === "listThreads") return async () => [...(codexReadable ? await codex.listThreads() : []), ...(codexReadable ? await claudeCatalog() : []), ...await additionalCatalog()];
      if (key === "listThreadPage") return async (cursor: string | null, options?: { useStateDbOnly: boolean }): Promise<ThreadListPage> => {
        if (!codexReadable || cursor === "acp:catalog") return { threads: await additionalCatalog(), nextCursor: null };
        if (cursor === "claude:catalog") return { threads: await claudeCatalog(), nextCursor: "acp:catalog" };
        const page = await codex.listThreadPage(cursor, options);
        return page.nextCursor ? page : { ...page, nextCursor: "claude:catalog" };
      };
      if (typeof key === "string" && routed.has(key)) return (...args: unknown[]) => {
        const first = args[0];
        const claudeTarget = typeof first === "string" ? isClaudeThread(first) || (typeof args[1] === "string" && isClaudeThread(args[1])) : isRecord(first) && (first.provider === "claude" || typeof first.nativeThreadId === "string" && isClaudeThread(first.nativeThreadId));
        const native = key === "inspectEnvironment" && typeof args[1] === "string" ? args[1] : typeof first === "string" ? first : isRecord(first) && typeof first.nativeThreadId === "string" ? first.nativeThreadId : undefined;
        const provider = native ? decodeProviderThread(native)?.provider : isRecord(first) && isAcpProvider(first.provider) ? first.provider : undefined;
        if (!provider && !codexReadable) throw new AgentError("AGENT_CAPABILITY_UNAVAILABLE", "Codex runtime is not compatible");
        const selected = provider ? additional.get(provider) : claudeTarget ? claude : target;
        if(!selected) throw new AgentError("AGENT_CAPABILITY_UNAVAILABLE", "Provider runtime is disabled");
        const method = Reflect.get(selected, key);
        if (typeof method !== "function") throw new AgentError("AGENT_CAPABILITY_UNAVAILABLE", "当前 Agent 不支持此操作");
        return Reflect.apply(method, selected, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
