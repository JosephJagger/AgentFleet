import { useEffect, useRef, useState } from "react";
import { t, systemText } from "../i18n";
import type { HostOperation, Machine, CommandReceipt } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";
export function NativeExperimentsPanel(props: { machine: Machine; hostOperations: HostOperation[]; onChanged: () => void }) {
  const op = useCodexOperation(props);
  const [version, setVersion] = useState(""); const [features, setFeatures] = useState<NonNullable<CommandReceipt["codexResult"]>["rows"]>([]);
  const [choice, setChoice] = useState(""); const [enabled, setEnabled] = useState(false); const [confirmed, setConfirmed] = useState(false);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => { if (!op.id || !op.result || applied.current === op.id) return; applied.current = op.id;
    if (op.result.operation === "experiments.read") { setVersion(op.result.rows.find(r => r.name === "version")?.detail ?? ""); setFeatures(op.result.rows.filter(r => r.name !== "version")); setChoice(""); }
    if (op.result.operation === "experiments.save") { setVersion(""); setConfirmed(false); }
  }, [op.id, op.result]);
  return <details className="codex-settings-panel"><summary>{t("原生功能开关")}</summary><div className="stack-form"><p>{t("只修改此主机。开发中或已废弃的开关仅供查看；保存后在新连接中生效，不中断现有任务。")}</p>
    <button type="button" disabled={op.pending || !op.allowed} onClick={() => void op.run("experiments.read")}>{t("读取功能开关")}</button>
    {features.length > 0 && <><label>{t("功能")}<select value={choice} onChange={e => { setChoice(e.target.value); setEnabled(features.find(r => r.name === e.target.value)?.status.endsWith(":on") ?? false); setConfirmed(false); }}><option value="">{t("请选择")}</option>{features.map(r => <option key={r.name} value={r.name} disabled={!/^(beta|stable):/.test(r.status)}>{r.detail || r.name} · {t(r.status.endsWith(":on") ? "已启用" : "已停用")} · {t(({ beta: "测试版", stable: "稳定版", underDevelopment: "开发中（只读）", deprecated: "已废弃（只读）", removed: "已移除（只读）" } as Record<string,string>)[r.status.split(":")[0]] ?? "只读")}</option>)}</select></label>
    {choice && <><label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={e => {setEnabled(e.target.checked); setConfirmed(false);}}/>{t("启用")}</label><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>{t("确认修改此主机原生功能开关")}</label><button type="button" disabled={!op.allowed || op.pending || !version || !confirmed} onClick={() => void op.run("experiments.save", {name:choice, enabled, version, confirmed:true})}>{t("保存")}</button></>}
    {op.result?.nextCursor && <button type="button" disabled={op.pending} onClick={() => void op.run("experiments.read",{cursor:op.result!.nextCursor})}>{t("下一页")}</button>}</>}
    {op.error && <p role="alert">{systemText(op.error)}</p>}{op.result?.status === "savedRequiresReconnect" && <p role="status">{t("已保存，重新连接 Codex 后生效。运行中任务不会被中断。")}</p>}
  </div></details>;
}
