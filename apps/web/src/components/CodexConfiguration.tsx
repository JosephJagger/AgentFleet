import { NativeConfigPanel } from "./NativeConfigPanel";
import { SettingsSections } from "./SettingsSections";
import { SlidersHorizontal, Headphones, ShieldCheck } from "lucide-react";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { t, systemText } from "../i18n";
import { api } from "../lib/api";
import type { Machine, Project } from "../lib/types";
import { CodexSettingsPanel } from "./CodexSettingsPanel";
import { PermissionPanel } from "./PermissionPanel";

function HostConfiguration({ machine }: { machine: Machine }) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const projectGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); ++projectGeneration.current; setProjects([]); setCursor(null); setLoading(true); setError("");
    void api.projects({ provider: "codex", machineId: machine.id, q: query || undefined, limit: 50 }, controller.signal).then(page => {
      if (!controller.signal.aborted) { setProjects(page.items); setCursor(page.nextCursor); }
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); ++projectGeneration.current; };
  }, [machine.id, query, retry]);
  async function more() {
    const generation = projectGeneration.current;
    setLoading(true); setError("");
    try {
      const page = await api.projects({ provider: "codex", machineId: machine.id, q: query || undefined, cursor, limit: 50 });
      if (projectGeneration.current !== generation) return;
      setProjects(p => [...p, ...page.items]); setCursor(page.nextCursor);
    } catch (e) { if (projectGeneration.current === generation) setError((e as Error).message); }
    finally { if (projectGeneration.current === generation) setLoading(false); }
  }
  return <div className="codex-config-target">
    <label>{t("搜索项目")}<input type="search" value={query} onChange={e => { setQuery(e.target.value); setProjectId(""); }} /></label>
    <label>{t("项目")}<select value={projectId} onChange={e => { setProjectId(e.target.value); }}><option value="">{t("主机默认（所有项目继承）")}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.alias} · {p.pathHint}</option>)}</select></label>
    {cursor && <button className="button button--quiet" type="button" disabled={loading} onClick={() => void more()}>{t("加载更多项目")}</button>}
    {error && <p role="alert">{systemText(error)} <button type="button" onClick={() => setRetry(n => n + 1)}>{t("重试")}</button></p>}
    <CodexSettingsPanel key={`model:${projectId}`} {...(projectId ? { projectId } : { machineId: machine.id })} /><PermissionPanel key={`permission:${projectId}`} {...(projectId ? { projectId } : { machineId: machine.id })} />
  </div>;
}
export function CodexConfiguration({ machines, initialMachineId }: { machines: Machine[]; initialMachineId?: string }) {
  const [tab, setTab] = useState<"defaults" | "exceptions" | "native">(initialMachineId ? "exceptions" : "defaults");
  const [query, setQuery] = useState("");
  const [machineId, setMachineId] = useState(initialMachineId ?? "");
  const [defaultsSection, setDefaultsSection] = useState<"runtime" | "voice" | "permissions">("runtime");
  const hosts = machines.filter(m => m.identity === "paired");
  const selected = hosts.find(m => m.id === machineId);
  return <section className="settings-block codex-configuration"><header className="config-heading"><h2><Settings2 size={18} />{t("Codex 配置")}</h2><p>{t("设置新任务和通话的默认行为。")}</p></header>
    <div className="codex-config-tabs" role="group" aria-label={t("Codex 配置分类")}>{(["defaults", "exceptions", "native"] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} className={`button ${tab === key ? "button--primary" : "button--quiet"}`} onClick={() => setTab(key)}>{t(({ defaults: "统一默认", exceptions: "单独配置", native: "原生配置" })[key])}</button>)}</div>
      {tab === "defaults" ? <>
        <p className="config-scope-hint">{t("作为所有会话的默认配置；主机、项目和会话仍可单独调整。")}</p>
        <SettingsSections label={t("默认配置分类")} value={defaultsSection} onChange={setDefaultsSection} items={[
          {id:"runtime",label:t("模型与回复"),icon:<SlidersHorizontal size={17}/>},
          {id:"voice",label:t("语音音色"),icon:<Headphones size={17}/>},
          {id:"permissions",label:t("执行权限"),icon:<ShieldCheck size={17}/>},
        ]}/>
        <div hidden={defaultsSection !== "runtime"} className="config-subpanel"><CodexSettingsPanel workspace /></div>
        <div hidden={defaultsSection !== "voice"} className="config-subpanel"><VoiceSettingsPanel /></div>
        <div hidden={defaultsSection !== "permissions"} className="config-subpanel"><PermissionPanel workspace /></div>
      </> : <>
        <label>{t("搜索主机")}<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <label>{t("主机")}<select value={machineId} onChange={e => setMachineId(e.target.value)}><option value="">{t("选择主机")}</option>{hosts.filter(m => m.id === machineId || `${m.name} ${m.hostname}`.toLowerCase().includes(query.toLowerCase())).map(m => <option key={m.id} value={m.id}>{m.name} · {t(m.reachability === "live" ? "在线" : "离线")}</option>)}</select></label>
        {selected && (tab === "native" ? <NativeConfigPanel key={selected.id} machine={selected}/> : <HostConfiguration key={selected.id} machine={selected} />)}
      </>}
  </section>;
}
