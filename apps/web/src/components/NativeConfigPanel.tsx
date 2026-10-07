import { NativeExperimentsPanel } from "./NativeExperimentsPanel";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
import type { HostOperation, Machine } from "../lib/types";
import { useCodexOperation } from "./useCodexOperation";

export function NativeConfigPanel({ machine }: { machine: Machine }) {
  const [operations, setOperations] = useState<HostOperation[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await api.hostOperations(machine.id, controller.signal); if (!controller.signal.aborted) { setOperations(next); setLoadError(""); } }
      catch (e) { if (!controller.signal.aborted) setLoadError((e as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 3000); }
    }; void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [machine.id, refresh]);
  const op = useCodexOperation({ machine, hostOperations: operations, onChanged: () => setRefresh(n => n + 1) });
  const [version, setVersion] = useState("");
  const [summary, setSummary] = useState("auto");
  const [verbosity, setVerbosity] = useState("medium");
  const [confirmed, setConfirmed] = useState(false);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!op.result || !op.id || applied.current === op.id) return; applied.current = op.id;
    if (op.result.operation === "config.read") {
      const value = (key: string) => op.result!.rows.find(r => r.name === key)?.detail;
      setVersion(value("version") ?? ""); setSummary(value("model_reasoning_summary") || "auto"); setVerbosity(value("model_verbosity") || "medium");
    } else if (op.result.operation === "config.save") { setVersion(""); setConfirmed(false); }
  }, [op.result, op.id]);
  return <section className="stack-form"><h3>{t("主机原生配置")}</h3><p>{t("读取此主机 Codex 的配置来源。这里只调整原生回复摘要和详细程度；模型、权限与语音默认值仍在统一默认中配置。账号与插件请前往主机的账号与工具。")}</p>
    <button type="button" className="button button--quiet" disabled={op.pending || !op.allowed} onClick={() => void op.run("config.read")}>{t("读取原生配置")}</button>
    {op.result?.operation === "config.read" && <dl>{op.result.rows.filter(r => r.name !== "version").map(r => <div key={r.name}><dt>{t(({ model: "模型", model_reasoning_effort: "推理强度", model_reasoning_summary: "推理摘要", model_verbosity: "回复详细程度", personality: "沟通风格", service_tier: "服务档位" } as Record<string,string>)[r.name] ?? r.name)}</dt><dd>{r.detail || t("原生默认")} · {t("来源")}: {r.status}</dd></div>)}</dl>}
    <label>{t("推理摘要")}<select value={summary} onChange={e => { setSummary(e.target.value); setConfirmed(false); }}>{[["auto","自动"],["concise","简短"],["detailed","详细"],["none","不显示"]].map(([v,l]) => <option key={v} value={v}>{t(l)}</option>)}</select></label>
    <label>{t("回复详细程度")}<select value={verbosity} onChange={e => { setVerbosity(e.target.value); setConfirmed(false); }}>{[["low","简洁"],["medium","适中"],["high","详细"]].map(([v,l]) => <option key={v} value={v}>{t(l)}</option>)}</select></label>
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t("保存到此主机的原生用户配置；重新连接后生效")}</label>
    <button type="button" className="button button--primary" disabled={op.pending || !op.allowed || !version || !confirmed} onClick={() => void op.run("config.save", { version, summary, verbosity, confirmed: true })}>{t("保存原生配置")}</button>
    {(op.error || loadError) && <p role="alert">{systemText(op.error || loadError)}</p>}{op.result?.status === "savedRequiresReconnect" && <p role="status">{t("已保存，重新连接 Codex 后生效。运行中任务不会被中断。")}</p>}
    <NativeExperimentsPanel machine={machine} hostOperations={operations} onChanged={() => setRefresh(n => n + 1)}/>
  </section>;
}
