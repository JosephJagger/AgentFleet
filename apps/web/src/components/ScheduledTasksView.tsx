import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronRight, Clock3, LoaderCircle, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { FleetSession, Machine, ScheduledRun, ScheduledTask, ScheduledTaskSchedule } from "../lib/types";
import { locale, t, systemText } from "../i18n";

type Props = {
  machines: Machine[];
  initialProjectId?: string;
  initialSessionId?: string;
  onSession: (id: string) => void;
  onToast: (tone: "success" | "info" | "danger", message: string) => void;
};

const dateTime = (value: string | null, timezone?: string) => value ? new Intl.DateTimeFormat(locale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const localFormatters = new Map<string,Intl.DateTimeFormat>();
const localParts = (date: Date, timezone: string) => {
  let formatter = localFormatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); localFormatters.set(timezone,formatter); }
  return Object.fromEntries(formatter.formatToParts(date).map(part => [part.type,part.value]));
};
const isoToLocalInput = (iso: string, timezone: string) => { const parts = localParts(new Date(iso), timezone); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; };
const localInputToIso = (value: string, timezone: string) => {
  const expected = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value : "";
  if (!expected) throw new Error(t("请选择有效的执行时间"));
  const approximate = Date.parse(`${value}:00Z`);
  for (let instant = approximate - 14 * 3600_000; instant <= approximate + 14 * 3600_000; instant += 60_000) {
    if (isoToLocalInput(new Date(instant).toISOString(), timezone) === expected) return new Date(instant).toISOString();
  }
  throw new Error(t("该当地时间在所选时区不存在，请更换时间"));
};
const nextLocal = () => {
  const date = new Date(Date.now() + 5 * 60_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}T${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
};
const kindLabel = (schedule: ScheduledTaskSchedule) => {
  if (schedule.kind === "once") return t("一次性");
  if (schedule.kind === "minutes") return t("每隔 {0} 分钟", schedule.everyMinutes);
  if (schedule.kind === "daily") return t("每天 {0}", schedule.time);
  if (schedule.kind === "weekdays") return t("工作日 {0}", schedule.time);
  return "weekdays" in schedule ? t("每周 {0} · {1}", schedule.weekdays.map((day: number) => [t("周日"),t("周一"),t("周二"),t("周三"),t("周四"),t("周五"),t("周六")][day]).join("、"), schedule.time) : t("工作日 {0}", schedule.time);
};
const runLabel: Record<ScheduledRun["status"], string> = {
  pending: "等待执行", dispatching: "正在派发", running: "执行中", succeeded: "已完成", failed: "失败", missed: "已错过", needs_attention: "需要处理",
};

export function ScheduledTasksView({ machines, initialProjectId, initialSessionId, onSession, onToast }: Props) {
  const projects = useMemo(() => machines.flatMap(machine => machine.projects.map(project => ({ ...project, machineName: machine.name }))), [machines]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessions, setSessions] = useState<FleetSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [destination, setDestination] = useState<"new" | "existing">(initialSessionId ? "existing" : "new");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduledTaskSchedule["kind"]>("once");
  const [localAt, setLocalAt] = useState(nextLocal);
  const [minutes, setMinutes] = useState(30);
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const result = await api.scheduledTasks();
    setTasks(result.tasks);
    if (selectedId) {
      const detail = await api.scheduledTask(selectedId).catch(() => null);
      setRuns(detail?.runs ?? []);
    }
  };
  useEffect(() => {
    let active = true;
    void api.scheduledTasks().then(result => { if (active) setTasks(result.tasks); }).catch(reason => { if (active) setError((reason as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (initialProjectId) setProjectId(initialProjectId); if (initialSessionId) { setSessionId(initialSessionId); setDestination("existing"); } }, [initialProjectId,initialSessionId]);
  useEffect(() => {
    if (!projectId || destination !== "existing") { setSessions([]); setNextCursor(null); return; }
    const controller = new AbortController();
    void api.sessions({ projectId, q: sessionQuery || undefined, limit: 30 }, controller.signal)
      .then(page => { if (!controller.signal.aborted) { setSessions(page.items.filter(item => item.state.ownership === "agentfleet_owned")); setNextCursor(page.nextCursor); } })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [projectId, destination, sessionQuery]);

  const reset = () => {
    setSelectedId(undefined); setRuns([]); setTitle(""); setPrompt(""); setKind("once"); setLocalAt(nextLocal()); setMinutes(30); setTime("09:00"); setWeekdays([1]); setDestination("new"); setSessionId(""); setError("");
  };
  const selectTask = async (task: ScheduledTask) => {
    setSelectedId(task.id); setProjectId(task.projectId); setTitle(task.title); setPrompt(task.prompt);
    setDestination(task.destinationKind); setSessionId(task.destinationSessionId ?? "");
    setKind(task.schedule.kind); setTimezone(task.timezone); setError("");
    if (task.schedule.kind === "once") {
      setLocalAt(isoToLocalInput(task.schedule.at,task.timezone));
    }
    if (task.schedule.kind === "minutes") setMinutes(task.schedule.everyMinutes);
    if ("time" in task.schedule) setTime(task.schedule.time);
    if (task.schedule.kind === "weekly") setWeekdays(task.schedule.weekdays);
    try { setRuns((await api.scheduledTask(task.id)).runs); } catch (reason) { setError((reason as Error).message); }
  };
  const selected = tasks.find(task => task.id === selectedId);
  const chosenProject = projects.find(project => project.id === projectId);

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (destination === "existing" && !sessionId) throw new Error(t("请选择已接管的会话"));
      const schedule: ScheduledTaskSchedule = kind === "once" ? { kind, at: localInputToIso(localAt,timezone) }
        : kind === "minutes" ? { kind, everyMinutes: minutes, startsAt: selected?.schedule.kind === "minutes" ? selected.schedule.startsAt : new Date(Date.now() + minutes * 60_000).toISOString() }
        : kind === "weekly" ? { kind, time, weekdays }
        : { kind, time };
      const input = { projectId, title, prompt, destinationSessionId: destination === "existing" ? sessionId : null, schedule, timezone };
      const result = selected ? await api.updateScheduledTask(selected.id, { ...input, enabled: selected.enabled }) : await api.createScheduledTask(input);
      await refresh();
      setSelectedId(result.task.id);
      setRuns((await api.scheduledTask(result.task.id)).runs);
      onToast("success", selected ? t("定时任务已更新") : t("定时任务已创建"));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="wide-view scheduled-view">
    <div className="wide-view__heading"><div><h1>{t("定时任务")}</h1><p>{t("让 Codex 在所选主机的项目中按时工作，并保留每次结果。")}</p></div><CalendarClock size={30}/></div>
    <div className="scheduled-layout">
      <aside className="scheduled-list">
        <div className="scheduled-list__heading"><strong>{t("任务列表")}</strong><button type="button" className="button button--quiet" onClick={reset}><Plus size={16}/>{t("新建")}</button></div>
        {loading && <p className="subtle">{t("读取中…")}</p>}
        {!loading && tasks.length === 0 && <p className="subtle">{t("还没有定时任务。选择项目后创建第一个任务。")}</p>}
        {tasks.map(task => <button type="button" key={task.id} className={`scheduled-list__item${task.id === selectedId ? " active" : ""}`} onClick={() => void selectTask(task)}>
          <strong>{task.title}</strong><span>{projects.find(project => project.id === task.projectId)?.alias ?? task.projectId} · {kindLabel(task.schedule)}</span>
          <small>{task.enabled ? t("下次：{0}", dateTime(task.nextAt,task.timezone)) : t("已暂停")}</small><ChevronRight size={16}/>
        </button>)}
      </aside>
      <div className="scheduled-editor">
        <h2>{selected ? t("编辑定时任务") : t("新建定时任务")}</h2>
        <form className="stack-form" onSubmit={event => void save(event)}>
          <label><span>{t("项目")}</span><select required value={projectId} disabled={Boolean(selected)} onChange={event => { setProjectId(event.target.value); setSessionId(""); }}><option value="">{t("选择项目")}</option>{projects.map(project => <option value={project.id} key={project.id}>{project.machineName} · {project.alias}</option>)}</select></label>
          <label><span>{t("任务名称")}</span><input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("例如：检查昨天的 CI 失败")} /></label>
          <label><span>{t("执行指令")}</span><textarea required rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t("说明每次触发时 Codex 应该完成什么，以及何时需要你确认。")}/></label>
          <div className="scheduled-choice"><span>{t("会话")}</span><label><input type="radio" checked={destination === "new"} onChange={() => { setDestination("new"); setSessionId(""); }}/>{t("每次新建会话")}</label><label><input type="radio" checked={destination === "existing"} onChange={() => setDestination("existing")}/>{t("使用项目里的已有会话")}</label></div>
          {destination === "existing" && <div className="scheduled-session-picker"><input aria-label={t("搜索已接管会话")} placeholder={t("搜索已接管会话…")} value={sessionQuery} onChange={event => setSessionQuery(event.target.value)}/><select required value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">{t("选择已接管的会话")}</option>{sessionId && !sessions.some(session => session.id === sessionId) && <option value={sessionId}>{selected?.destinationSessionId === sessionId ? t("已选会话") : sessionId}</option>}{sessions.map(session => <option value={session.id} key={session.id}>{session.title}</option>)}</select>{nextCursor && <button type="button" className="button button--quiet" onClick={async () => { const page = await api.sessions({ projectId, q: sessionQuery || undefined, cursor: nextCursor, limit: 30 }); setSessions(current => [...current,...page.items.filter(item => item.state.ownership === "agentfleet_owned")]); setNextCursor(page.nextCursor); }}>{t("加载更多会话")}</button>}<small>{t("未接管的会话请先在工作台接管。")}</small></div>}
          <label><span>{t("执行频率")}</span><select value={kind} onChange={event => setKind(event.target.value as ScheduledTaskSchedule["kind"])}><option value="once">{t("一次性")}</option><option value="minutes">{t("每隔 N 分钟")}</option><option value="daily">{t("每天")}</option><option value="weekdays">{t("工作日")}</option><option value="weekly">{t("每周几")}</option></select></label>
          {kind === "once" && <label><span>{t("执行时间")}</span><input type="datetime-local" required value={localAt} onChange={event => setLocalAt(event.target.value)}/></label>}
          {kind === "minutes" && <label><span>{t("间隔分钟数（1–10080）")}</span><input type="number" min={1} max={10080} required value={minutes} onChange={event => setMinutes(Number(event.target.value))}/></label>}
          {["daily","weekdays","weekly"].includes(kind) && <label><span>{t("当地时间")}</span><input type="time" required value={time} onChange={event => setTime(event.target.value)}/></label>}
          {kind === "weekly" && <fieldset className="scheduled-weekdays"><legend>{t("星期几")}</legend>{[0,1,2,3,4,5,6].map(day => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(current => event.target.checked ? [...current,day] : current.filter(value => value !== day))}/>{[t("周日"),t("周一"),t("周二"),t("周三"),t("周四"),t("周五"),t("周六")][day]}</label>)}</fieldset>}
          <label><span>{t("时区")}</span><input required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></label>
          {chosenProject && <p className="subtle">{t("将在 {0} 的原项目目录中执行；同项目任务会顺序等待。离线超过 24 小时不补跑。", chosenProject.machineName)}</p>}
          {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
          <div className="scheduled-editor__actions"><button type="submit" className="button button--primary" disabled={busy || !projectId}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/ >}{selected ? t("保存任务") : t("创建任务")}</button>
            {selected && <><button type="button" className="button button--quiet" disabled={busy} onClick={async () => { setBusy(true); try { await api.setScheduledTaskEnabled(selected.id,!selected.enabled); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>{selected.enabled ? <Pause size={16}/> : <Play size={16}/ >}{selected.enabled ? t("暂停") : t("启用")}</button><button type="button" className="button button--quiet" disabled={busy} onClick={async () => { if (!window.confirm(t("删除此定时任务及其运行记录？已创建的 Codex 会话会保留。"))) return; setBusy(true); try { await api.deleteScheduledTask(selected.id); reset(); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}><Trash2 size={16}/>{t("删除")}</button></>}
          </div>
        </form>
        {selected && <div className="scheduled-runs"><h3>{t("运行记录")}</h3>{runs.length === 0 && <p className="subtle">{t("尚未运行")}</p>}{runs.map(run => <div className="scheduled-run" key={run.run_id}><Clock3 size={16}/><div><strong>{t(runLabel[run.status])}</strong><span>{dateTime(run.scheduled_at,selected.timezone)}{run.detail ? ` · ${systemText(run.detail)}` : ""}</span></div>{run.session_id && <button type="button" className="button button--quiet" onClick={() => onSession(run.session_id!)}>{t("打开会话")}</button>}</div>)}</div>}
      </div>
    </div>
  </section>;
}
