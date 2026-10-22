import { isWorktree, projectFamilies, sessionLocation, worktreeName } from "../lib/project-tree";
import { providerName, type ProviderId } from "../lib/provider-catalog";
import { displayName } from "../lib/display-name";
import { agentName } from "../lib/agent-provider";
import { UsageButton } from "./UsageButton";
import { t, locale, systemText } from "../i18n";
import { ChevronLeft, ChevronRight, FolderGit2, GitBranch, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FleetSession, Page, Project } from "../lib/types";

function SessionRows({ sessions, selectedId, onSelect }: { sessions: FleetSession[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <div className="session-list">{sessions.map((session) => <button type="button" key={session.id} className={`session-row${selectedId === session.id ? " session-row--active" : ""}`} onClick={() => onSelect(session.id)}>
    <div className="session-row__top"><strong>{displayName(session.title)}</strong><span className="session-time">{new Date(session.lastActivityAt).toLocaleDateString(locale(), { month: "numeric", day: "numeric" })}</span></div>
    <div className="session-row__meta"><span>{displayName(session.machineName)} · {agentName(session.provider)} · {displayName(sessionLocation(session))}</span></div>
    <div className="session-row__bottom"><span className="state-pill">{session.state.unknownFreeze ? t("结果待核验") : session.state.reachability !== "live" ? t("离线") : session.state.waitReason === "approval" ? t("等待确认") : session.state.waitReason === "user_input" ? t("等待回答") : session.state.currentTurn === "in_progress" ? t("正在执行") : t("空闲")}</span><span className="history-mark">{session.state.history === "complete" ? t("完整历史") : session.state.history === "partial" ? t("部分历史") : t("历史摘要")}</span><span className="session-row__tokens" title={t("总消耗 {0} tokens",session.recordedTokens==null?"—":new Intl.NumberFormat(locale()).format(session.recordedTokens))+" · "+t("本周消耗 {0} tokens",session.weeklyTokens==null?"—":new Intl.NumberFormat(locale()).format(session.weeklyTokens))+(session.weeklyBoundaryIncomplete?" · "+t("跨越重置时刻且无法精确拆分的用量未计入本轮。"):"")}>{t("总消耗 {0} tokens",session.recordedTokens==null?"—":new Intl.NumberFormat(locale(),{notation:"compact",maximumFractionDigits:1}).format(session.recordedTokens))}{" · "}{t("本周消耗 {0} tokens",session.weeklyTokens==null?"—":new Intl.NumberFormat(locale(),{notation:"compact",maximumFractionDigits:1}).format(session.weeklyTokens))}{session.weeklyBoundaryIncomplete?" *":""}</span></div>
  </button>)}</div>;
}

function Activity({ projects }: { projects: Project[] }) {
  const sum = projects.reduce((a,p)=>({running:a.running+(p.activity?.running??0),waiting:a.waiting+(p.activity?.waiting??0),uncertain:a.uncertain+(p.activity?.uncertain??0)}),{running:0,waiting:0,uncertain:0});
  return <span className="catalog-family-activity">{sum.running>0&&<span>{t('执行中 {0}',sum.running)}</span>}{sum.waiting>0&&<span>{t('等待确认 {0}',sum.waiting)}</span>}{sum.uncertain>0&&<span>{t('待核验 {0}',sum.uncertain)}</span>}</span>;
}
function ProjectGroup({ project, worktrees = [], parent, expanded, expandedIds, selectedId, refreshKey, onToggle, onSelect, onCreate, onSchedule }: { project: Project; worktrees?: Project[]; parent?: Project; expanded: boolean; expandedIds: Set<string>; selectedId?: string; refreshKey: string; onToggle: (id: string) => void; onSelect: (id: string) => void; onCreate: (project: Project) => void; onSchedule?: (project: Project) => void }) {
  const lane = isWorktree(project);
  const groupId = `${project.id}:worktrees`;
  const lanesOpen = expandedIds.has(groupId);
  const mainOpen = !worktrees.length || !expandedIds.has(`${project.id}:main-collapsed`);
  const [page, setPage] = useState<Page<FleetSession>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  useEffect(() => {
    if (!expanded || !mainOpen) return;
    const controller = new AbortController();
    setLoading(true);
    // Refresh the whole loaded window atomically, not just its first 30 rows.
    // Aborted requests never replace rows, cursors or the latest loading state.
    void (async () => {
      const items = new Map<string, FleetSession>();
      let cursor: string | null = null;
      for (let index = 0; index < pageCount; index += 1) {
        const next = await api.sessions({ projectId: project.id, limit: 30, ...(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        for (const item of next.items) items.set(item.id, item);
        cursor = next.nextCursor;
        if (!cursor) break;
      }
      setPage({ items: [...items.values()], nextCursor: cursor });
      setLoaded(true); setError("");
    })().catch((reason) => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, expanded, mainOpen, refreshKey, retry, pageCount]);
  return <section className={`project-session-group${lane ? " project-session-group--worktree" : ""}`} aria-busy={loading}>
    <div className="catalog-project-heading"><button className="project-session-group__heading" type="button" aria-expanded={expanded} onClick={()=>onToggle(project.id)}>{lane ? <GitBranch size={16} /> : <FolderGit2 size={16} />}<span className="project-session-group__copy"><strong>{displayName(lane ? worktreeName(project,parent) : project.alias)}{worktrees.length>0&&<span className="catalog-worktree-count">{t("工作树 · {0}",worktrees.length)}</span>}{lane&&<span className="catalog-worktree-label">{t('工作树')}</span>}<span className="project-agent-label">{agentName(project.provider)}</span></strong>{lane ? <span className="catalog-worktree-branch">{t('分支：{0}',project.gitBranch || t('未上报'))}</span> : <span>{displayName(project.pathHint)}</span>}<Activity projects={[project,...worktrees]} /></span><ChevronRight className={expanded ? "catalog-expanded" : ""} size={17} /></button>
      <div className="project-usage">{worktrees.length>0&&<small>{t('项目汇总（含工作树）')}</small>}{lane&&<small>{t('此工作树用量')}</small>}<UsageButton scope="project" id={project.id} provider={project.provider} includeWorktrees={worktrees.length>0} onSession={onSelect}/></div>
      {lane && <details className="catalog-worktree-path"><summary>{t('目录详情')}</summary><code>{displayName(project.pathHint)}</code>{!parent&&<small>{t('所属项目：{0}',displayName(project.repoRoot!))}</small>}</details>}
    </div>
    {expanded && worktrees.length>0&&<button type="button" className="catalog-worktrees-toggle catalog-main-toggle" aria-label={t("主目录会话")} aria-expanded={mainOpen} aria-controls={`catalog-project-${project.id}`} onClick={()=>onToggle(`${project.id}:main-collapsed`)}><ChevronRight size={16} className={mainOpen?'catalog-expanded':''}/><FolderGit2 size={16}/><strong>{t('主目录会话')}</strong><Activity projects={[project]}/></button>}
    {expanded && mainOpen && <div id={`catalog-project-${project.id}`} className="project-session-group__children">{error && <p className="catalog-error" role="alert">{systemText(error)}<button type="button" onClick={() => setRetry((value) => value + 1)}>{t("重试")}</button></p>}<SessionRows sessions={page.items} selectedId={selectedId} onSelect={onSelect} />{loading && !loaded ? <div className="catalog-loading"><LoaderCircle className="spin" size={16} />{t("正在读取会话")}</div> : loaded && page.items.length === 0 && !error ? <p className="catalog-empty">{t("暂无会话，点击下方新会话开始。")}</p> : null}{page.nextCursor && <button className="catalog-more" type="button" disabled={loading} onClick={() => setPageCount((count) => count + 1)}>{t("加载更多会话")}</button>}<div className="project-session-group__actions"><button type="button" className="project-create-session" aria-label={displayName(t("在 {0} 新建会话", project.alias))} onClick={() => onCreate(project)}><Plus size={16} /><span>{t("新会话")}</span></button>{onSchedule && <button type="button" className="project-create-session" aria-label={displayName(t("管理 {0} 的定时任务", project.alias))} onClick={() => onSchedule(project)}><span>{t("定时任务")}</span></button>}</div></div>}
    {expanded && worktrees.length>0 && <div className="catalog-worktrees"><button type="button" className="catalog-worktrees-toggle" aria-expanded={lanesOpen} aria-controls={groupId} onClick={()=>onToggle(groupId)}><ChevronRight size={16} className={lanesOpen?"catalog-expanded":""}/><GitBranch size={16}/><strong>{t('工作树 · {0}',worktrees.length)}</strong><Activity projects={worktrees}/></button>{lanesOpen&&<div id={groupId} className="catalog-worktrees-list">{worktrees.map(child=><ProjectGroup key={child.id} project={child} parent={project} expanded={expandedIds.has(child.id)} expandedIds={expandedIds} selectedId={selectedId} refreshKey={refreshKey} onToggle={onToggle} onSelect={onSelect} onCreate={onCreate} onSchedule={onSchedule}/>)}</div>}</div>}
  </section>;
}

export function WorkspaceCatalog({ provider = "codex", machineId, selectedSession, refreshKey, onSelect, onCreate, onCreateProject, onSchedule }: { provider?: ProviderId; machineId?: string; selectedSession?: FleetSession; refreshKey: string; onSelect: (id: string) => void; onCreate: (project?: Project) => void; onCreateProject?: () => void; onSchedule?: (project: Project) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [projectPage, setProjectPage] = useState(1);
  const [projects, setProjects] = useState<Page<Project>>({ items: [], nextCursor: null });
  const [matches, setMatches] = useState<Page<FleetSession>>({ items: [], nextCursor: null });
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string>();
  const scopeKey = JSON.stringify([machineId, provider, query, filter, cursor, projectPage]);
  const loaded = loadedKey === scopeKey;
  const searching = Boolean(query.trim() || filter);
  const storageKey = `agentfleet.project-tree:${machineId ?? "all"}:${provider}`;
  const revealed = useRef('');
  useEffect(() => {
    setCursor(null); setPrevious([]); setProjectPage(1); setQuery(''); setFilter(''); revealed.current='';
    try { revealed.current=localStorage.getItem(`${storageKey}:selection`)??''; } catch { /* Browsing without storage remains supported. */ }
    try { const saved:unknown=JSON.parse(localStorage.getItem(storageKey)??'[]');setExpanded(new Set(Array.isArray(saved)?saved.filter((v):v is string=>typeof v==='string'):[])); } catch { setExpanded(new Set()); }
  }, [storageKey]);
  const toggle = (id:string) => setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);try{localStorage.setItem(storageKey,JSON.stringify([...next]));}catch{}return next;});
  useEffect(()=>{
    if (!selectedSession || (machineId && selectedSession.machineId!==machineId) || (selectedSession.provider??"codex")!==provider) return;
    const selected=projects.items.find(p=>p.id===selectedSession.projectId);
    if(!selected)return;
    const revealKey=`${storageKey}:${selectedSession.id}:${selected.parentProjectId??''}`;
    if(revealed.current===revealKey)return;
    revealed.current=revealKey;
    setExpanded(current=>{
      const next=new Set([...current,selected.id,...(selected.parentProjectId?[selected.parentProjectId,`${selected.parentProjectId}:worktrees`]:[])]);
      next.delete(`${selected.id}:main-collapsed`);
      try {
        localStorage.setItem(storageKey,JSON.stringify([...next]));
        localStorage.setItem(`${storageKey}:selection`,revealKey);
      } catch { /* Keep the current selection usable when storage is unavailable. */ }
      return next;
    });
  },[selectedSession?.id,selectedSession?.projectId,projects.items,storageKey,machineId,provider]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        if (searching) { const next = await api.sessions({ machineId, provider, q: query.trim(), executionState: filter || undefined, cursor, limit: 30 }, controller.signal); if (!controller.signal.aborted) setMatches(next); }
        else { const next = await api.projects({ machineId, provider, offset: (projectPage - 1) * 8, limit: 8, groupWorktrees: true, ...(selectedSession && (!machineId || selectedSession.machineId===machineId) && (selectedSession.provider??"codex")===provider ? {includeProjectId:selectedSession.projectId} : {}) }, controller.signal); if (!controller.signal.aborted) setProjects(next); }
        if (!controller.signal.aborted) { setLoadedKey(scopeKey); setError(""); }
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 200 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [machineId, provider, query, filter, cursor, refreshKey, retry, scopeKey, selectedSession?.projectId]);
  const nextCursor = searching ? matches.nextCursor : projects.nextCursor;
  const totalProjectPages = Math.max(1, Math.ceil((projects.total ?? projects.items.length) / 8));
  useEffect(() => {
    if (!searching && projectPage > totalProjectPages) setProjectPage(totalProjectPages);
  }, [projectPage, searching, totalProjectPages]);
  const visibleProjects = [...projects.items];

  return <section className="session-list-panel workspace-catalog" aria-busy={loading}>
    <div className="section-heading"><div><div className="eyebrow">{t("当前主机")}</div><h2>{t("项目与会话")}</h2></div><div className="catalog-heading-actions">{onCreateProject && <button type="button" className="button button--quiet" onClick={onCreateProject}><FolderGit2 size={15} />{t("新项目")}</button>}<button type="button" className="button button--quiet" onClick={() => onCreate()}><Plus size={15} />{t("新会话")}</button></div></div>
    <div className="catalog-search"><label><Search size={15} /><input aria-label={t("搜索项目或会话")} placeholder={t("搜索项目或会话…")} value={query} onChange={(event) => { setQuery(event.target.value); setCursor(null); setPrevious([]); setProjectPage(1); }} /></label><select aria-label={t("筛选会话状态")} value={filter} onChange={(event) => { setFilter(event.target.value); setCursor(null); setPrevious([]); setProjectPage(1); }}><option value="">{t("全部状态")}</option><option value="running">{t("正在执行")}</option><option value="awaiting_approval">{t("等待确认")}</option><option value="idle">{t("空闲")}</option><option value="unknown">{t("待核验")}</option></select></div>
    {error && <p className="catalog-error" role="alert">{systemText(error)}<button type="button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={13} />{t("重试")}</button></p>}
    {loading && !loaded && <div className="catalog-loading"><LoaderCircle className="spin" size={15} />{t("正在更新列表")}</div>}
    {searching ? <SessionRows sessions={matches.items} selectedId={selectedSession?.id} onSelect={onSelect} /> : projectFamilies(visibleProjects).map(({project,worktrees}) => <ProjectGroup key={project.id} project={project} worktrees={worktrees} expanded={expanded.has(project.id)} expandedIds={expanded} selectedId={selectedSession?.id} refreshKey={refreshKey} onToggle={toggle} onSelect={onSelect} onCreate={onCreate} onSchedule={onSchedule} />)}
    {loaded && !error && (searching ? matches.items.length === 0 : projects.items.length === 0) && <p className="catalog-empty">{searching ? t("没有匹配的会话，试试其他关键词或状态。") : t("暂无项目。连接主机后会自动发现已有 {0} 项目。", providerName(provider))}</p>}
    {!searching && totalProjectPages > 1 && <nav className="project-pagination" aria-label={t("项目分页")}><span className="project-pagination__range">{t("第 {0} / {1} 页", projectPage, totalProjectPages)}</span><span className="project-pagination__actions"><button type="button" aria-label={t("上一页")} disabled={projectPage === 1 || loading} onClick={() => setProjectPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><button type="button" aria-label={t("下一页")} disabled={projectPage === totalProjectPages || loading} onClick={() => setProjectPage((page) => Math.min(totalProjectPages, page + 1))}><ChevronRight size={15} /></button></span></nav>}
    {searching && (previous.length > 0 || nextCursor) && <nav className="project-pagination" aria-label={t("会话分页")}><span className="project-pagination__range">{t("第 {0} 页", previous.length + 1)}</span><span className="project-pagination__actions"><button type="button" aria-label={t("上一页")} disabled={!previous.length || loading} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((current) => current.slice(0, -1)); }}><ChevronLeft size={15} /></button><button type="button" aria-label={t("下一页")} disabled={!nextCursor || loading} onClick={() => { setPrevious((current) => [...current, cursor]); setCursor(nextCursor); }}><ChevronRight size={15} /></button></span></nav>}
  </section>;
}
