import { useState } from "react";
import { t, systemText } from "../i18n";
import type { FleetSession, CommandReceipt } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";
export function SubagentsPanel(props:{session:FleetSession;commands:CommandReceipt[];onChanged:()=>void}) {
 const op=useCodexOperation(props);const [thread,setThread]=useState("");
 return <details className="codex-settings-panel"><summary>{t("子代理进度")}</summary><div className="stack-form"><p>{t("查看当前会话直接派出的子代理与回复。子代理继续由原任务管理，查看不会接管或打断它。")}</p>
 <button type="button" disabled={op.pending || !op.allowed} onClick={()=>{setThread("");void op.run("subagents.read");}}>{t("刷新子代理")}</button>
 {op.result?.operation === "subagents.read" && <div className="workspace-file-list">{!op.result.rows.length && <p>{t("此页没有当前会话的子代理")}</p>}{op.result.rows.map(r=><button type="button" key={r.name} disabled={op.pending} onClick={()=>{setThread(r.name);void op.run("subagents.history",{threadId:r.name});}}><span>{r.detail || r.name}</span><small>{r.status}</small></button>)}</div>}
 {op.result?.operation === "subagents.history" && <div className="workspace-file-list">{op.result.rows.map((r,i)=><article key={i}><strong>{t(r.name)} · {r.status}</strong><p className="subagent-text">{r.detail}</p></article>)}</div>}
 {op.result?.nextCursor && <button type="button" disabled={op.pending} onClick={()=>void op.run(thread?"subagents.history":"subagents.read",{...(thread?{threadId:thread}:{}),cursor:op.result!.nextCursor})}>{t("下一页")}</button>}
 {op.error && <p role="alert">{systemText(op.error)}</p>}
 </div></details>;
}
