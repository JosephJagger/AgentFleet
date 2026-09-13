import { useState } from "react";
import { api } from "../lib/api";
import type { WritingMemoryState, WritingEntry } from "../lib/writing-assistance";
import { t } from "../i18n";
import { sessionPath } from "../lib/session-workspace";
import { softwareTermCount } from "../lib/prompt-completions";

export function WritingMemoryPanel({ sessionId, value, error, refresh }: { sessionId:string; value?:WritingMemoryState; error:string; refresh:()=>Promise<void> }) {
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const [query,setQuery] = useState("");
  const [editing,setEditing] = useState<WritingEntry>();
  const [phrase,setPhrase] = useState("");
  const [replacement,setReplacement] = useState("");
  const [scope,setScope] = useState("project");
  async function run(action:()=>Promise<unknown>) {
    setBusy(true); setMessage("");
    try { await action(); await refresh(); }
    catch { setMessage(t("词库更新失败，请重试")); }
    finally { setBusy(false); }
  }
  return <details className="session-config-section writing-memory-panel"><summary>{t("词库与自动学习")}</summary>
    <p>{t("内置 {0} 个术语；自动提取的新词需确认后才参与建议。", softwareTermCount)} <a href="/software-terms-LICENSE.txt" target="_blank" rel="noreferrer">CSpell · MIT</a></p>
    {(message || error) && <p role="alert">{message || t("词库暂不可用，基础补全仍可使用")}</p>}
    {!value ? <button type="button" className="button button--quiet" onClick={()=>void refresh()}>{t("读取词库")}</button> : <>
      <label className="writing-toggle"><input type="checkbox" checked={value.enabled} disabled={busy} onChange={event=>void run(()=>api.writingLearning(sessionId,event.target.checked,value.scope))}/>{t("从新同步的对话中自动学习")}</label>
      <p>{t("仅提取消息中的标注术语与明确释义，跳过代码块和明显敏感内容。关闭后保留已有词库；删除的词不会自动学回。")}</p>
      <label>{t("自动学习保存到")}<select value={value.scope} disabled={busy} onChange={event=>void run(()=>api.writingLearning(sessionId,value.enabled,event.target.value))}><option value="project">{t("项目词库")}</option><option value="personal">{t("个人词库")}</option></select></label>
      <p>{t("词库归当前账号所有，个人词库跨项目使用，项目词库仅在当前项目使用；已确认词条独立保存，可手动删除。")}</p>
      <label>{t("搜索词库")}<input value={query} onChange={event=>setQuery(event.target.value)} /></label>
      <div className="writing-memory-list">{value.entries.filter(entry=>(entry.phrase+entry.replacement).toLowerCase().includes(query.toLowerCase())).map(entry=><article key={entry.id}>
        <strong>{entry.phrase}</strong><p>{entry.replacement}</p><small>{entry.status === "candidate" ? t("待确认") : t("已确认")} · {entry.scope === "project" ? t("项目词库") : t("个人词库")}</small>
        {entry.source_session && <a href={sessionPath(entry.source_session)}>{t("来源会话")}</a>}
        <div className="writing-entry-actions"><button type="button" disabled={busy} onClick={()=>{setEditing(entry);setPhrase(entry.phrase);setReplacement(entry.replacement);setScope(entry.scope);}}>{t("编辑")}</button>
        {entry.status === "candidate" && <button type="button" disabled={busy} onClick={()=>void run(()=>api.saveWritingEntry(sessionId,entry,entry.id))}>{t("确认采用")}</button>}
        <button type="button" disabled={busy} onClick={()=>void run(()=>api.deleteWritingEntry(sessionId,entry.id))}>{t("删除")}</button></div>
      </article>)}</div>
      {value.entries.length === 0 && <p>{t("尚无学习记录，可添加术语或等待新对话同步。")}</p>}
      <form className="writing-entry-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await api.saveWritingEntry(sessionId,{phrase,replacement,scope},editing?.id);setEditing(undefined);setPhrase("");setReplacement("");});}}>
        <h4>{editing ? t("编辑词条") : t("添加词条")}</h4>
        <label>{t("原表达或术语")}<input required minLength={2} maxLength={120} value={phrase} onChange={event=>setPhrase(event.target.value)} /></label>
        <label>{t("专业表达或完整术语")}<textarea required minLength={2} maxLength={500} rows={2} value={replacement} onChange={event=>setReplacement(event.target.value)} /></label>
        <label>{t("保存范围")}<select value={scope} onChange={event=>setScope(event.target.value)}><option value="project">{t("项目词库")}</option><option value="personal">{t("个人词库")}</option></select></label>
        <button className="button button--primary" disabled={busy || !phrase.trim() || !replacement.trim()}>{t("保存词条")}</button>
        {editing && <button type="button" onClick={()=>{setEditing(undefined);setPhrase("");setReplacement("");}}>{t("取消编辑")}</button>}
      </form>
    </>}
  </details>;
}
