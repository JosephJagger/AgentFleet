import { useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
import { useCodexOperation } from "./useCodexOperation";
import type { FleetSession, CommandReceipt } from "../lib/types";

export function WorkspaceHistory(props: { session: FleetSession; commands: CommandReceipt[]; onChanged: () => void }) {
 const op = useCodexOperation(props);
 const [turn, setTurn] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [id, setId] = useState(""); const [confirmed, setConfirmed] = useState(false);
 const receipt = props.commands.find(c => c.id === id);
 const pending = busy || !!id && (!receipt || ["accepted", "dispatching", "unknown"].includes(receipt.state));
 async function fork() {
  setBusy(true); setError("");
  try { const session = props.session; const r = await api.command(session.id, { type: "thread.fork", clientMutationId: crypto.randomUUID(), payload: { beforeTurnId: turn }, precondition: { nativeThreadId: session.nativeThreadId, executionSegmentId: session.executionSegmentId, threadControlVersion: session.threadControlVersion, projectLeaseVersion: session.projectLeaseVersion, expectedActiveTurnId: null } }); setId(r.command.id); props.onChanged(); }
  catch(e) { setError((e as Error).message); } finally { setBusy(false); }
 }
 return <section className="stack-form"><h3>{t("从历史重新开始")}</h3><p>{t("选择一轮任务，从它开始前创建新分支。原会话保留，项目文件不会回滚；新分支不会自动执行任务。")}</p>
  <button type="button" className="button button--quiet" disabled={op.pending || !op.allowed || pending} onClick={() => void op.run("history.turns")}>{t("读取历史任务")}</button>
  {op.result && <><label>{t("选择任务")}<select value={turn} onChange={e => { setTurn(e.target.value); setConfirmed(false); }}><option value="">{t("请选择")}</option>{op.result.rows.map(row => <option key={row.name} value={row.name}>{row.detail.slice(0,120)} · {row.status}</option>)}</select></label>{op.result.nextCursor && <button type="button" disabled={op.pending || pending} onClick={() => void op.run("history.turns", { cursor: op.result!.nextCursor })}>{t("更早的任务")}</button>}</>}
  <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{t("确认从所选任务之前创建新分支")}</label>
  <button type="button" className="button button--primary" disabled={!turn || !confirmed || pending || op.pending || !props.session.actions?.fork?.allowed} onClick={() => void fork()}>{t("创建分支")}</button>
  {(error || op.error || receipt?.message) && <p role="status">{systemText(error || op.error || receipt?.message || "")}</p>}
  {receipt?.state === "succeeded" && <p role="status">{t("分支已创建，请从项目会话列表打开。")}</p>}
 </section>;
}
