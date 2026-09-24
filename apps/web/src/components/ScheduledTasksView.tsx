import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronRight, LoaderCircle, Pause, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { FleetSession, Machine, ScheduledHistoryRun, ScheduledRun, ScheduledTask, ScheduledTaskSchedule } from "../lib/types";
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
  const [sidebarTab, setSidebarTab] = useState<"tasks" | "history">("tasks");
  const [history, setHistory] = useState<ScheduledHistoryRun[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessions, setSessions] = useState<FleetSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
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
  const lockedProjectId = selectedId ? projectId : undefined;

  const refresh = async () => {
    const [result, recent] = await Promise.all([api.scheduledTasks(), api.scheduledHistory()]);
    setTasks(result.tasks);
    setHistory(recent.runs);
  };
  useEffect(() => {
    let active = true;
    void Promise.all([api.scheduledTasks(), api.scheduledHistory()]).then(([result, recent]) => { if (active) { setTasks(result.tasks); setHistory(recent.runs); } }).catch(reason => { if (active) setError((reason as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { const timer = window.setInterval(() => void refresh().catch(() => {}), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (initialProjectId) setProjectId(initialProjectId); if (initialSessionId) { setSessionId(initialSessionId); setDestination("existing"); } }, [initialProjectId,initialSessionId]);
  useEffect(() => {
    if (destination !== "existing") { setSessions([]); setNextCursor(null); return; }
    const controller = new AbortController();
    setSessionLoading(true);
    void api.sessions({ managed: true, projectId: lockedProjectId, q: sessionQuery.trim() || undefined, limit: 50 }, controller.signal)
      .then(page => { if (!controller.signal.aborted) { setSessions(page.items); setNextCursor(page.nextCursor); } })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setSessionLoading(false); });
    return () => controller.abort();
  }, [destination, sessionQuery, lockedProjectId]);

  const reset = () => {
    setSidebarTab("tasks"); setSelectedId(undefined); setTitle(""); setPrompt(""); setKind("once"); setLocalAt(nextLocal()); setMinutes(30); setTime("09:00"); setWeekdays([1]); setDestination("new"); setSessionId(""); setError("");
  };
  const selectTask = (task: ScheduledTask) => {
    setSelectedId(task.id); setProjectId(task.projectId); setTitle(task.title); setPrompt(task.prompt);
    setDestination(task.destinationKind); setSessionId(task.destinationSessionId ?? "");
    setKind(task.schedule.kind); setTimezone(task.timezone); setError("");
    if (task.schedule.kind === "once") {
      setLocalAt(isoToLocalInput(task.schedule.at,task.timezone));
    }
    if (task.schedule.kind === "minutes") setMinutes(task.schedule.everyMinutes);
    if ("time" in task.schedule) setTime(task.schedule.time);
    if (task.schedule.kind === "weekly") setWeekdays(task.schedule.weekdays);
  };
  const selected = tasks.find(task => task.id === selectedId);
  const chosenProject = projects.find(project => project.id === projectId);
  const targetReady = destination === "new" ? Boolean(projectId) : Boolean(projectId && sessionId);

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
      onToast("success", selected ? t("定时任务已更新") : t("定时任务已创建"));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="wide-view scheduled-view">
    <div className="wide-view__heading"><div><h1>{t("定时任务")}</h1><p>{t("让 Codex 在所选主机的项目中按时工作，并保留每次结果。")}</p></div><CalendarClock size={30}/></div>
    <div className="scheduled-layout">
      <aside className="scheduled-list">
        <div className="scheduled-list__heading"><strong>{t("任务列表")}</strong><button type="button" className="button button--quiet" onClick={reset}><Plus size={16}/>{t("新建")}</button></div>
        <div className="scheduled-list__tabs"><button type="button" className={sidebarTab === "tasks" ? "active" : ""} onClick={() => setSidebarTab("tasks")}>{t("任务")}</button><button type="button" className={sidebarTab === "history" ? "active" : ""} onClick={() => setSidebarTab("history")}>{t("历史记录")}</button></div>
        {sidebarTab === "tasks" && loading && <p className="subtle">{t("读取中…")}</p>}
        {sidebarTab === "tasks" && !loading && tasks.length === 0 && <p className="subtle">{t("还没有定时任务。选择项目或会话后创建第一个任务。")}</p>}
        {sidebarTab === "tasks" && tasks.map(task => <button type="button" key={task.id} className={`scheduled-list__item${task.id === selectedId ? " active" : ""}`} onClick={() => void selectTask(task)}>
          <strong>{task.title}</strong><span>{projects.find(project => project.id === task.projectId)?.alias ?? task.projectId} · {kindLabel(task.schedule)}</span>
          <small>{task.enabled ? t("下次：{0}", dateTime(task.nextAt,task.timezone)) : t("已暂停")}</small><ChevronRight size={16}/>
        </button>)}
        {sidebarTab === "history" && <section className="scheduled-history"><div className="scheduled-list__heading"><strong>{t("历史记录")}</strong><button type="button" className="button button--quiet" onClick={() => void refresh().catch(reason => setError((reason as Error).message))}>{t("刷新")}</button></div>
          {history.length === 0 && <p className="subtle">{t("尚无执行记录")}</p>}
          <div className="scheduled-history__list">{history.map(run => <div className="scheduled-history__item" key={run.run_id}><strong>{run.title}</strong><span>{t(runLabel[run.status])} · {dateTime(run.scheduled_at)}</span>{run.detail && <small>{systemText(run.detail)}</small>}{run.session_id && <button type="button" onClick={() => onSession(run.session_id!)}>{t("打开会话")}</button>}</div>)}</div>
        </section>}
      </aside>
      <div className="scheduled-editor">
        <h2>{selected ? t("编辑定时任务") : t("新建定时任务")}</h2>
        <form className="stack-form" onSubmit={event => void save(event)}>
          <div className="scheduled-choice"><span>{t("会话")}</span><label><input type="radio" checked={destination === "new"} onChange={() => { setDestination("new"); setSessionId(""); if (!selected) setProjectId(""); }}/>{t("每次新建会话")}</label><label><input type="radio" checked={destination === "existing"} onChange={() => { setDestination("existing"); setSessionId(""); if (!selected) setProjectId(""); }}/>{t("使用项目里的已有会话")}</label></div>
          {destination === "new" ? <label><span>{t("项目")}</span><select required value={projectId} disabled={Boolean(selected)} onChange={event => setProjectId(event.target.value)}><option value="">{t("选择项目")}</option>{projects.map(project => <option value={project.id} key={project.id}>{project.machineName} · {project.alias}</option>)}</select></label> : <div className="scheduled-session-picker">
            <label><span>{t("搜索已接管会话")}</span><input placeholder={t("搜索主机、项目或会话")} value={sessionQuery} onChange={event => setSessionQuery(event.target.value)}/></label>
            {sessionId && <div className="scheduled-session-selected"><Check size={16}/><span>{sessions.find(session => session.id === sessionId)?.title ?? t("已选会话")} · {chosenProject?.machineName ?? ""} / {chosenProject?.alias ?? projectId}</span></div>}
            <div className="scheduled-session-results" role="listbox" aria-label={t("选择已接管的会话")}>
              {sessionLoading && <p className="subtle">{t("正在加载会话")}</p>}
              {!sessionLoading && sessions.length === 0 && <p className="subtle">{t("没有匹配的已接管会话")}</p>}
              {sessions.map(session => <button type="button" role="option" aria-selected={session.id === sessionId} className={session.id === sessionId ? "active" : ""} key={session.id} onClick={() => { setSessionId(session.id); setProjectId(session.projectId); }}><strong>{session.title}</strong><small>{session.machineName} · {session.projectAlias}</small></button>)}
            </div>
            {nextCursor && <button type="button" className="button button--quiet" onClick={async () => { setSessionLoading(true); try { const page = await api.sessions({ managed: true, projectId: lockedProjectId, q: sessionQuery.trim() || undefined, cursor: nextCursor, limit: 50 }); setSessions(current => [...current,...page.items]); setNextCursor(page.nextCursor); } catch (reason) { setError((reason as Error).message); } finally { setSessionLoading(false); } }}>{t("加载更多会话")}</button>}
            <small>{t("未接管的会话请先在工作台接管。")}</small>
          </div>}
          {!targetReady && <p className="subtle">{t("先选择项目或已接管会话，再设置任务内容和时间。")}</p>}
          <fieldset className="scheduled-details" disabled={!targetReady}>
          <label><span>{t("任务名称")}</span><input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder={t("例如：检查昨天的 CI 失败")} /></label>
          <label><span>{t("执行指令")}</span><textarea required rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t("说明每次触发时 Codex 应该完成什么，以及何时需要你确认。")}/></label>
          <label><span>{t("执行频率")}</span><select value={kind} onChange={event => setKind(event.target.value as ScheduledTaskSchedule["kind"])}><option value="once">{t("一次性")}</option><option value="minutes">{t("每隔 N 分钟")}</option><option value="daily">{t("每天")}</option><option value="weekdays">{t("工作日")}</option><option value="weekly">{t("每周几")}</option></select></label>
          {kind === "once" && <label><span>{t("执行时间")}</span><input type="datetime-local" required value={localAt} onChange={event => setLocalAt(event.target.value)}/></label>}
          {kind === "minutes" && <label><span>{t("间隔分钟数（1–10080）")}</span><input type="number" min={1} max={10080} required value={minutes} onChange={event => setMinutes(Number(event.target.value))}/></label>}
          {["daily","weekdays","weekly"].includes(kind) && <label><span>{t("当地时间")}</span><input type="time" required value={time} onChange={event => setTime(event.target.value)}/></label>}
          {kind === "weekly" && <fieldset className="scheduled-weekdays"><legend>{t("星期几")}</legend>{[0,1,2,3,4,5,6].map(day => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(current => event.target.checked ? [...current,day] : current.filter(value => value !== day))}/>{[t("周日"),t("周一"),t("周二"),t("周三"),t("周四"),t("周五"),t("周六")][day]}</label>)}</fieldset>}
          <label><span>{t("时区")}</span><input required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Shanghai"/></label>
          </fieldset>
          {chosenProject && <p className="subtle">{t("将在 {0} 的原项目目录中执行；同项目任务会顺序等待。离线超过 24 小时不补跑。", chosenProject.machineName)}</p>}
          {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
          <div className="scheduled-editor__actions"><button type="submit" className="button button--primary" disabled={busy || !targetReady}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/ >}{selected ? t("保存任务") : t("创建任务")}</button>
            {selected && <><button type="button" className="button button--quiet" disabled={busy} onClick={async () => { setBusy(true); try { await api.setScheduledTaskEnabled(selected.id,!selected.enabled); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>{selected.enabled ? <Pause size={16}/> : <Play size={16}/ >}{selected.enabled ? t("暂停") : t("启用")}</button><button type="button" className="button button--quiet" disabled={busy} onClick={async () => { if (!window.confirm(t("删除此定时任务及其运行记录？已创建的 Codex 会话会保留。"))) return; setBusy(true); try { await api.deleteScheduledTask(selected.id); reset(); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}><Trash2 size={16}/>{t("删除")}</button></>}
          </div>
        </form>
      </div>
    </div>
  </section>;
}
