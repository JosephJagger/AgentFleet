import { VoiceSettingsPanel } from "./VoiceSettingsPanel";
import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { t, systemText } from "../i18n";
import { api } from "../lib/api";
import type { Machine, Project, FleetSession, CommandReceipt, HostOperation } from "../lib/types";
import { CodexSettingsPanel } from "./CodexSettingsPanel";
import { PermissionPanel } from "./PermissionPanel";
import { CodexOperationsPanel } from "./CodexOperationsPanel";
import { CodexInspectionPanel } from "./CodexInspectionPanel";

function HostNativeManagement({ machine }: { machine: Machine }) {
  const [operations, setOperations] = useState<HostOperation[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await api.hostOperations(machine.id, controller.signal); if (!controller.signal.aborted) { setOperations(next); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 4000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [machine.id, reload]);
  return <div><h3>{t("主机账号与原生环境")}</h3><p>{t("直接管理所选主机的账号、额度、插件和原生环境，无需选择或创建会话。变更仅影响此主机，不会同步账号到其他主机。")}</p>
    {error ? <p role="alert">{systemText(error)}</p> : <CodexOperationsPanel machine={machine} hostOperations={operations} onChanged={() => setReload(n => n + 1)} />}
  </div>;
}
function NativeManagement({ sessionId }: { sessionId: string }) {
  const [context, setContext] = useState<{ session: FleetSession; commands: CommandReceipt[] }>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api.codexManagementContext(sessionId, controller.signal);
        if (!controller.signal.aborted) { setContext(next); setError(""); }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 4000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, reload]);
  return <>{error && <p role="alert">{systemText(error)}</p>}{context ? <>
    <p className="codex-config-context">{t("操作上下文：")}{context.session.title}</p>
    {!error && <><CodexOperationsPanel session={context.session} commands={context.commands} onChanged={() => setReload(n => n + 1)} /><CodexInspectionPanel session={context.session} commands={context.commands} onChanged={() => setReload(n => n + 1)} /></>}
  </> : <p>{t("读取中")}</p>}</>;
}
function HostConfiguration({ machine, native }: { machine: Machine; native: boolean }) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessions, setSessions] = useState<FleetSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const projectGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); ++projectGeneration.current; setProjects([]); setCursor(null); setLoading(true); setError("");
    void api.projects({ provider: "codex", machineId: machine.id, q: query || undefined, limit: 50 }, controller.signal).then(page => {
      if (!controller.signal.aborted) { setProjects(page.items); setCursor(page.nextCursor); }
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); ++projectGeneration.current; };
  }, [machine.id, query, retry]);
  useEffect(() => {
    if (!native) return;
    const controller = new AbortController(); ++sessionGeneration.current; setSessions([]); setSessionCursor(null); setError(""); setLoading(true);
    void api.sessions({ provider: "codex", machineId: machine.id, projectId: projectId || undefined, managed: true, q: sessionQuery || undefined, limit: 50 }, controller.signal).then(page => {
      if (!controller.signal.aborted) { setSessions(page.items); setSessionCursor(page.nextCursor); }
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); ++sessionGeneration.current; };
  }, [machine.id, projectId, sessionQuery, native, retry]);
  async function more(kind: "projects" | "sessions") {
    const ref = kind === "projects" ? projectGeneration : sessionGeneration; const generation = ref.current;
    setLoading(true); setError("");
    try {
      if (kind === "projects") { const page = await api.projects({ provider: "codex", machineId: machine.id, q: query || undefined, cursor, limit: 50 }); if (ref.current !== generation) return; setProjects(p => [...p, ...page.items]); setCursor(page.nextCursor); }
      else { const page = await api.sessions({ provider: "codex", machineId: machine.id, managed: true, projectId: projectId || undefined, q: sessionQuery || undefined, cursor: sessionCursor, limit: 50 }); if (ref.current !== generation) return; setSessions(p => [...p, ...page.items]); setSessionCursor(page.nextCursor); }
    } catch (e) { if (ref.current === generation) setError((e as Error).message); } finally { if (ref.current === generation) setLoading(false); }
  }
  return <div className="codex-config-target">
    {native && <HostNativeManagement machine={machine} />}
    {native && <h3>{t("需要会话上下文的工具")}</h3>}
    <label>{t("搜索项目")}<input type="search" value={query} onChange={e => { setQuery(e.target.value); setProjectId(""); setSessionId(""); }} /></label>
    <label>{t("项目")}<select value={projectId} onChange={e => { setProjectId(e.target.value); setSessionId(""); }}><option value="">{t(native ? "全部项目" : "主机默认（所有项目继承）")}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.alias} · {p.pathHint}</option>)}</select></label>
    {cursor && <button className="button button--quiet" type="button" disabled={loading} onClick={() => void more("projects")}>{t("加载更多项目")}</button>}
    {error && <p role="alert">{systemText(error)} <button type="button" onClick={() => setRetry(n => n + 1)}>{t("重试")}</button></p>}
    {native ? <>
      <p>{t("目标、附件、队列和项目 MCP 工具需要会话上下文。仅使用这些工具时选择会话；不会自动接管或新建会话。")}</p>
      <label>{t("搜索会话")}<input type="search" value={sessionQuery} onChange={e => { setSessionQuery(e.target.value); setSessionId(""); }} /></label>
      <label>{t("操作会话")}<select value={sessionId} onChange={e => setSessionId(e.target.value)}><option value="">{t("选择已接管的会话")}</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      {sessionCursor && <button className="button button--quiet" type="button" disabled={loading} onClick={() => void more("sessions")}>{t("加载更多会话")}</button>}
      {!loading && !sessions.length && <p>{t("没有匹配的已接管会话，请调整搜索或先在工作台接管会话。")}</p>}
      {sessionId && <NativeManagement key={sessionId} sessionId={sessionId} />}
    </> : <><CodexSettingsPanel key={`model:${projectId}`} {...(projectId ? { projectId } : { machineId: machine.id })} /><PermissionPanel key={`permission:${projectId}`} {...(projectId ? { projectId } : { machineId: machine.id })} /></>}
  </div>;
}
export function CodexConfiguration({ machines, initialMachineId }: { machines: Machine[]; initialMachineId?: string }) {
  const [tab, setTab] = useState<"defaults" | "exceptions" | "native">(initialMachineId ? "exceptions" : "defaults");
  const [query, setQuery] = useState("");
  const [machineId, setMachineId] = useState(initialMachineId ?? "");
  const [open, setOpen] = useState(!!initialMachineId);
  const hosts = machines.filter(m => m.identity === "paired");
  const selected = hosts.find(m => m.id === machineId);
  return <section className="settings-block codex-configuration"><details open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary><h2><Settings2 size={18} />{t("Codex 配置")}</h2><span>{t("统一默认、主机与项目例外、原生工具与账号")}</span></summary>
    {open && <><div className="codex-config-tabs" role="group" aria-label={t("Codex 配置分类")}>{(["defaults", "exceptions", "native"] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} className={`button ${tab === key ? "button--primary" : "button--quiet"}`} onClick={() => setTab(key)}>{t(({ defaults: "统一默认", exceptions: "主机与项目例外", native: "原生工具与账号" })[key])}</button>)}</div>
      {tab === "defaults" ? <><CodexSettingsPanel workspace /><VoiceSettingsPanel /><PermissionPanel workspace /></> : <>
        <label>{t("搜索主机")}<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <label>{t("主机")}<select value={machineId} onChange={e => setMachineId(e.target.value)}><option value="">{t("选择主机")}</option>{hosts.filter(m => m.id === machineId || `${m.name} ${m.hostname}`.toLowerCase().includes(query.toLowerCase())).map(m => <option key={m.id} value={m.id}>{m.name} · {t(m.reachability === "live" ? "在线" : "离线")}</option>)}</select></label>
        {selected && <HostConfiguration key={`${selected.id}:${tab}`} machine={selected} native={tab === "native"} />}
      </>}
    </>}
  </details></section>;
}
