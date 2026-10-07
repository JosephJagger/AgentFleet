import { FolderOpen } from "lucide-react";
import { ConfigDisclosureSummary } from "./ConfigDisclosureSummary";
import { useEffect, useRef, useState } from "react";
import type { Machine, HostOperation } from "../lib/types";
import { t, systemText } from "../i18n";
import { useCodexOperation } from "./useCodexOperation";

export function SkillRootsPanel(props: { machine: Machine; hostOperations: HostOperation[]; onChanged: () => void }) {
 const op = useCodexOperation(props); const [roots, setRoots] = useState(""); const [version, setVersion] = useState(""); const [confirmed, setConfirmed] = useState(false); const applied = useRef<string | undefined>(undefined);
 useEffect(() => {
  if (!op.result || !op.id || applied.current === op.id) return; applied.current = op.id;
  if (op.result.operation === "skills.roots.read") { setRoots(op.result.rows.filter(r => r.name === "root").map(r => r.detail).join("\n")); setVersion(op.result.rows.find(r => r.name === "version")?.detail ?? ""); }
  else { setVersion(""); setConfirmed(false); }
 }, [op.result, op.id]);
 return <details className="codex-settings-panel config-disclosure"><ConfigDisclosureSummary icon={FolderOpen}>{t("额外技能目录")}</ConfigDisclosureSummary><div className="stack-form config-disclosure__body"><p>{t("添加此主机上的技能文件夹，每行一个绝对路径。目录由连接服务保存，新 Codex 进程自动加载；已有连接重新连接后生效。")}</p>
  <button type="button" className="button button--quiet" disabled={op.pending || !op.allowed} onClick={() => void op.run("skills.roots.read")}>{t("读取技能目录")}</button>
  <label>{t("技能目录")}<textarea value={roots} disabled={op.pending || !version} onChange={e => { setRoots(e.target.value); setConfirmed(false); }}/></label>
  <label className="checkbox-row"><input type="checkbox" checked={confirmed} disabled={op.pending} onChange={e => setConfirmed(e.target.checked)}/>{t("确认使用这些目录中的技能；留空会移除额外目录")}</label>
  <button type="button" className="button button--primary" disabled={!version || !confirmed || op.pending || !op.allowed} onClick={() => void op.run("skills.roots.save", { roots: roots.split(/\r?\n/).map(s => s.trim()).filter(Boolean), version, confirmed: true })}>{t("保存技能目录")}</button>
  {op.error && <p role="alert">{systemText(op.error)}</p>}{op.result?.status === "savedRequiresReconnect" && <p role="status">{t("已保存，已有 Codex 连接重新连接后生效。")}</p>}
 </div></details>;
}
