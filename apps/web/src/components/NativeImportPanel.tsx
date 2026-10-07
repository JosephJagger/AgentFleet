import { Import } from "lucide-react";
import { ConfigDisclosureSummary } from "./ConfigDisclosureSummary";
import { useEffect, useRef, useState } from "react";
import { t, systemText } from "../i18n";
import type { HostOperation, Machine, CommandReceipt } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";
export function NativeImportPanel(props: { machine: Machine; hostOperations: HostOperation[]; onChanged: () => void }) {
  const op = useCodexOperation(props); const [items,setItems] = useState<NonNullable<CommandReceipt["codexResult"]>["rows"]>([]); const [selected,setSelected] = useState<string[]>([]); const [confirmed,setConfirmed] = useState(false);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => { if (!op.id || !op.result || applied.current === op.id) return; applied.current = op.id;
    if (op.result.operation === "migration.detect") { setItems(op.result.rows); setSelected([]); setConfirmed(false); }
    if (op.result.operation === "migration.import") { setItems([]); setSelected([]); setConfirmed(false); }
  },[op.id,op.result]);
  return <details className="codex-settings-panel config-disclosure"><ConfigDisclosureSummary icon={Import}>{t("导入其他工具的配置与历史")}</ConfigDisclosureSummary><div className="stack-form config-disclosure__body"><p>{t("由此主机的 Codex 检测用户目录中的可导入内容，历史限最近 30 天、最多 25 个会话。先预览再选择；导入会修改此主机原生配置或历史，不会同步登录凭据。")}</p>
    <div className="workspace-actions"><button type="button" disabled={op.pending || !op.allowed} onClick={() => void op.run("migration.detect")}>{t("预览可导入内容")}</button><button type="button" disabled={op.pending || !op.allowed} onClick={() => void op.run("migration.history")}>{t("查看导入记录")}</button></div>
    {items.length > 0 && <><div className="workspace-file-list">{items.map(r => <label className="checkbox-row" key={r.name}><input type="checkbox" checked={selected.includes(r.name)} onChange={e => {setSelected(e.target.checked ? [...selected,r.name] : selected.filter(id=>id!==r.name));setConfirmed(false);}}/><span>{r.detail}<small>{r.status}</small></span></label>)}</div><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t("确认将勾选内容导入此主机 Codex")}</label><button type="button" disabled={!confirmed || !selected.length || op.pending || !op.allowed} onClick={()=>void op.run("migration.import",{itemIds:selected,confirmed:true})}>{t("导入所选内容")}</button></>}
    {op.result?.operation === "migration.detect" && !items.length && <p>{t("未检测到可导入内容")}</p>}
    {op.result && op.result.operation !== "migration.detect" && <ul>{op.result.rows.map((r,i)=><li key={i}>{r.name} · {r.detail} · {r.status}</li>)}</ul>}
    {op.error && <p role="alert">{systemText(op.error)}</p>}
  </div></details>;
}
