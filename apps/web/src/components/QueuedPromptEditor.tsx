import { useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
export function QueuedPromptEditor({ sessionId, itemId, prompt, version, onChanged }: {sessionId:string;itemId:string;prompt:string;version:number;onChanged:()=>void}) {
  const [editing,setEditing]=useState(false); const [text,setText]=useState(prompt);const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [mutation,setMutation]=useState("");
  if (!editing) return <button type="button" onClick={()=>{setText(prompt);setMutation(crypto.randomUUID());setError("");setEditing(true);}}>{t("编辑")}</button>;
  return <div className="queue-editor"><label>{t("编辑等待中的消息")}<textarea value={text} disabled={busy} onChange={e=>{setText(e.target.value);setMutation(crypto.randomUUID());}}/></label><p>{t("保留附件、顺序和原到期时间；保存时重新校验执行配置。已派发的任务不能编辑。")}</p><div className="workspace-actions"><button type="button" disabled={busy || !text.trim()} onClick={async()=>{setBusy(true);setError("");try{await api.editQueuedTurn(sessionId,itemId,version,text,mutation);setEditing(false);onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{t("保存")}</button><button type="button" disabled={busy} onClick={()=>setEditing(false)}>{t("取消编辑")}</button></div>{error&&<p role="alert">{systemText(error)}</p>}</div>;
}
