import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Users, X } from "lucide-react";
import { api } from "../lib/api";
import { displayName } from "../lib/display-name";
import { nativeSubagentRunning, nativeSubagentStatus, type NativeSubagentSnapshot } from "../lib/native-subagents";
import { systemText, t } from "../i18n";
import type { FleetSession } from "../lib/types";

const POLL_MS = 5_000;
type ReadState = { sessionId: string; value?: NativeSubagentSnapshot; error?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : t("进度暂时无法更新");

/** These are observation requests only. Never create tasks or resume native children here. */
export function useNativeSubagents(sessionId: string | undefined, enabled: boolean, open: boolean) {
  const [list, setList] = useState<ReadState>();
  const [history, setHistory] = useState<ReadState & { childId: string }>();
  const [selection, setSelection] = useState<{ sessionId: string; childId: string }>();
  const [listPages, setListPages] = useState<Array<string | undefined>>([undefined]);
  const [historyPages, setHistoryPages] = useState<Array<string | undefined>>([undefined]);
  const [revision, setRevision] = useState(0);
  const listGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const childId = selection && selection.sessionId === sessionId ? selection.childId : undefined;
  const listCursor = listPages.at(-1);
  const historyCursor = historyPages.at(-1);

  useEffect(() => {
    setSelection(undefined);
    setList(undefined);
    setHistory(undefined);
    setListPages([undefined]);
    setHistoryPages([undefined]);
  }, [sessionId, enabled]);

  useEffect(() => {
    const generation = ++listGeneration.current;
    if (!enabled || !sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !controller.signal.aborted && generation === listGeneration.current;
    const poll = async () => {
      try {
        const value = await api.nativeSubagents(sessionId, listCursor ? { cursor: listCursor } : {}, controller.signal);
        if (valid()) setList({ sessionId, value });
      } catch (error) {
        if (valid()) setList(previous => ({ sessionId, value: previous?.sessionId === sessionId ? previous.value : undefined, error: errorText(error) }));
      } finally {
        if (valid()) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled, listCursor, revision]);

  useEffect(() => {
    const generation = ++historyGeneration.current;
    if (!enabled || !open || !sessionId || !childId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !controller.signal.aborted && generation === historyGeneration.current;
    const poll = async () => {
      try {
        const value = await api.nativeSubagents(sessionId, { childId, ...(historyCursor ? { cursor: historyCursor } : {}) }, controller.signal);
        if (value.childId && value.childId !== childId) throw new Error(t("会话已切换，请在当前会话重试"));
        if (valid()) setHistory({ sessionId, childId, value });
      } catch (error) {
        if (valid()) setHistory(previous => ({ sessionId, childId, value: previous?.sessionId === sessionId && previous.childId === childId ? previous.value : undefined, error: errorText(error) }));
      } finally {
        if (valid()) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, enabled, open, childId, historyCursor, revision]);

  const scoped = enabled && list?.sessionId === sessionId ? list : undefined;
  const childHistory = enabled && history && history.sessionId === sessionId && history.childId === childId ? history : undefined;
  return {
    items: scoped?.value?.items ?? [], provider: scoped?.value?.provider,
    loaded: Boolean(scoped?.value), error: scoped?.error,
    childId, history: childHistory?.value, historyError: childHistory?.error,
    select: (id: string) => { if (sessionId) { setSelection({ sessionId, childId: id }); setHistory(undefined); setHistoryPages([undefined]); } },
    refresh: () => setRevision(n => n + 1),
    listNext: scoped?.value?.nextCursor,
    listHasPrevious: listPages.length > 1,
    listPage: (next: boolean) => { setList(undefined); setListPages(pages => next && scoped?.value?.nextCursor ? [...pages, scoped.value.nextCursor] : pages.slice(0, -1)); },
    historyHasPrevious: historyPages.length > 1,
    historyPage: (next: boolean) => { setHistory(undefined); setHistoryPages(pages => next && childHistory?.value?.nextCursor ? [...pages, childHistory.value.nextCursor] : pages.slice(0, -1)); },
  };
}

export type NativeSubagentsState = ReturnType<typeof useNativeSubagents>;

export function NativeSubagentsTrigger({ state, open, onClick }: { state: NativeSubagentsState; open: boolean; onClick: () => void }) {
  const running = state.items.filter(item => nativeSubagentRunning(item.status)).length;
  return <button type="button" className="button button--quiet native-subagents-trigger" aria-label={t("子 Agent")} aria-expanded={open} aria-controls="native-subagents-pane" onClick={onClick} title={state.error ? t("进度暂时无法更新") : t("查看主助手的分工与回复")}>
    <Users size={16} /><span>{t("子 Agent")}</span>
    <span className="native-subagents-count">{state.loaded ? t("本页 {0}", state.items.length) : ""}</span>
    {running > 0 && <span className="native-subagents-running">{t("{0} 执行中", running)}</span>}
    {state.error && <span className="native-subagents-warning" aria-label={t("进度暂时无法更新")}>!</span>}
  </button>;
}

export function NativeSubagents({ session, state, onClose }: { session: FleetSession; state: NativeSubagentsState; onClose: () => void }) {
  const provider = (state.provider ?? session.provider) === "claude" ? "Claude Code" : "Codex";
  const selected = state.items.find(item => item.id === state.childId);
  return <section className="native-subagents" id="native-subagents-pane" aria-label={t("子 Agent 进度")}>
    <header className="native-subagents-head"><Users size={17}/><strong>{t("子 Agent")}</strong><span>{provider}</span><button type="button" aria-label={t("刷新子 Agent 进度")} onClick={state.refresh}><RefreshCw size={15}/></button><button type="button" aria-label={t("收起子 Agent")} onClick={onClose}><X size={17}/></button></header>
    <div className="native-subagents-body">
      <p className="native-subagents-intro">{t("直接在主会话说明目标，主助手会按需要分工。")}</p>
      {state.error && <p role="alert" className="native-subagents-error">{systemText(state.error)}{state.loaded && <small>{t("保留最后已知状态")}</small>}</p>}
      {!state.loaded && !state.error && <p role="status">{t("正在读取子 Agent")}</p>}
      {state.loaded && !state.items.length && <div className="native-subagents-empty"><Users size={28}/><strong>{t("暂未发现子 Agent")}</strong><p>{t("简单任务可由主助手直接完成；需要分工时，子任务会自动出现在这里。")}</p></div>}
      <div className="native-subagents-list" aria-label={t("子 Agent 列表")}>
        {state.items.map(item => <button key={item.id} type="button" aria-pressed={state.childId === item.id} onClick={() => state.select(item.id)}>
          <span className="native-subagents-item-title">{displayName(item.title || item.id)}</span><span data-state={item.status}>{t(nativeSubagentStatus(item.status))}</span>
          {item.description && <small>{displayName(item.description)}</small>}
        </button>)}
      </div>
      {(state.listHasPrevious || state.listNext) && <div className="native-subagents-pages"><button type="button" disabled={!state.listHasPrevious} onClick={() => state.listPage(false)}><ChevronLeft size={14}/>{t("上一页")}</button><button type="button" disabled={!state.listNext} onClick={() => state.listPage(true)}>{t("下一页")}<ChevronRight size={14}/></button></div>}
      {state.childId && <section className="native-subagents-history" aria-label={t("子 Agent 对话")}>
        <h3>{displayName(selected?.title || state.childId)}</h3>
        <small>{t("任务和回复由原生助手管理，查看不会打断执行。")}</small>
        {state.historyError && <p role="alert" className="native-subagents-error">{systemText(state.historyError)}</p>}
        {!state.history && !state.historyError && <p role="status">{t("正在读取对话")}</p>}
        {state.history && !state.history.messages?.length && <p>{t("暂未读取到任务或回复")}</p>}
        {state.history?.messages?.map((message, index) => <article key={`${message.id ?? index}:${message.textOffset ?? 0}`}><strong>{message.role === "user" ? t("任务要求") : t("子 Agent 回复")}</strong>{message.status && <small>{t(nativeSubagentStatus(message.status))}</small>}<p>{displayName(message.text)}</p>{message.truncated && <small className="native-subagents-segment">{t("长消息分段显示，当前为第 {0}–{1} / {2} 字符", (message.textOffset ?? 0) + 1, (message.textOffset ?? 0) + message.text.length, message.textLength ?? "?")}{state.history?.nextCursor && ` · ${t("下一页查看后续")}`}</small>}</article>)}
        {(state.historyHasPrevious || state.history?.nextCursor) && <div className="native-subagents-pages"><button type="button" disabled={!state.historyHasPrevious} onClick={() => state.historyPage(false)}><ChevronLeft size={14}/>{t("上一页")}</button><button type="button" disabled={!state.history?.nextCursor} onClick={() => state.historyPage(true)}>{t("下一页")}<ChevronRight size={14}/></button></div>}
      </section>}
    </div>
  </section>;
}
