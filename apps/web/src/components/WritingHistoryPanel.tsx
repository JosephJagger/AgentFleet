import { useState } from "react";
import { api } from "../lib/api";
import { t } from "../i18n";
export type WritingHistoryState = { truncated: boolean; interactions: { id: string; paired: boolean; state: string; feedback: string | null; messages: { eventId: string; role: "user" | "assistant"; text: string; truncated: boolean }[] }[] };
export function WritingHistoryPanel({ sessionId }: { sessionId: string }) {
  const [value,setValue] = useState<WritingHistoryState>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState(false);
  async function run(action: () => Promise<WritingHistoryState>) {
    setBusy(true); setError(false);
    try { setValue(await action()); } catch { setError(true); } finally { setBusy(false); }
  }
  return <details className="session-config-section writing-history-panel">
    <summary>{t("问答记录与反馈")}</summary>
    <p>{t("按原始轮次关联用户提问和助手回复。完成不代表正确；反馈仅归当前账号，不会把答案自动加入词库。")}</p>
    <button type="button" className="button button--quiet" disabled={busy} onClick={()=>void run(()=>api.writingHistory(sessionId))}>{t("读取最近问答")}</button>
    {error && <p role="alert">{t("问答记录暂不可用，请重试")}</p>}
    {value?.interactions.length === 0 && <p>{t("暂无可用问答；内容关闭同步或过期后不再显示。")}</p>}
    {value?.truncated && <p>{t("仅显示最近保留的部分记录，完整内容请查看会话。")}</p>}
    <div className="writing-memory-list">{value?.interactions.map(item=><article key={item.id}>
      <strong>{item.paired ? t("已关联问答") : t("关联不完整")}</strong>
      <small> · {item.state === "completed" ? t("已结束，效果未验证") : item.state === "failed" ? t("执行失败") : item.state === "interrupted" ? t("执行中断") : t("结束状态未知")}</small>
      <details><summary>{t("查看原始消息")}</summary>{item.messages.map(message=><div key={message.eventId}>
        <strong>{message.role === "user" ? t("用户提问") : t("助手回复（未验证）")}</strong>
        <p className="writing-history-message">{message.text}{message.truncated ? "…" : ""}</p>
      </div>)}</details>
      {item.paired && <div className="writing-entry-actions">
        <button type="button" disabled={busy} aria-pressed={item.feedback === "useful"} onClick={()=>void run(()=>api.writingHistoryFeedback(sessionId,item.id,"useful"))}>{t("对我有用")}</button>
        <button type="button" disabled={busy} aria-pressed={item.feedback === "unhelpful"} onClick={()=>void run(()=>api.writingHistoryFeedback(sessionId,item.id,"unhelpful"))}>{t("没有帮助")}</button>
        {item.feedback && <button type="button" disabled={busy} onClick={()=>void run(()=>api.writingHistoryFeedback(sessionId,item.id,"clear"))}>{t("撤销反馈")}</button>}
      </div>}
    </article>)}</div>
  </details>;
}
