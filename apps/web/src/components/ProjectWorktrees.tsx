import { AlertTriangle, GitBranch, GitMerge, LoaderCircle, Plus, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { agentName } from "../lib/agent-provider";
import { PROVIDER_IDS, type ProviderId } from "../lib/provider-catalog";
import { startLaneSession, waitForOperation } from "../lib/worktrees";
import { t, systemText } from "../i18n";
import type { Machine, WorktreeDiff, WorktreeLane, WorktreeOverview } from "../lib/types";
import { SessionConfiguration } from "./SessionConfiguration";

/** Agents this host can run; Codex is always present, others when their CLI was found. */
export function laneProviders(machine?: Machine): ProviderId[] {
  return PROVIDER_IDS.filter(id => id === "codex" || (id === "claude" ? machine?.agentRuntimes?.claude?.installed === true : machine?.agentRuntimes?.[id]?.installed === true));
}

function LaneCreate({ overview, providers, onCreated }: { overview: WorktreeOverview; providers: ProviderId[]; onCreated: (sessionId: string) => void }) {
  const [provider, setProvider] = useState<ProviderId>(providers[0] ?? "codex");
  const [name, setName] = useState("");
  const [base, setBase] = useState(overview.current ?? overview.branches[0] ?? "");
  const [setup, setSetup] = useState(overview.setupScript);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="stack-form worktree-create" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError("");
    void startLaneSession(overview.project.projectId, overview.project.machineId, { provider, ...(name.trim() ? { name: name.trim() } : {}), ...(base ? { base } : {}), setup }, t("{0} · 工作树", agentName(provider)))
      .then(result => onCreated(result.sessionId)).catch(reason => setError((reason as Error).message)).finally(() => setBusy(false));
  }}>
    <div className="worktree-create__grid">
      <label>{t("智能体")}<select value={provider} onChange={e => setProvider(e.target.value as ProviderId)}>{providers.map(id => <option key={id} value={id}>{agentName(id)}</option>)}</select></label>
      <label>{t("分支")}<select value={base} onChange={e => setBase(e.target.value)}>{overview.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label>
      <label>{t("名称（可选）")}<input value={name} maxLength={48} pattern="[a-z0-9][a-z0-9._-]*" placeholder="login-fix" onChange={e => setName(e.target.value.toLowerCase())} /><small>{t("新分支为 af/{0}", name || t("自动生成"))}</small></label>
    </div>
    <label className="checkbox-row"><input type="checkbox" checked={setup} disabled={!overview.setupScript} onChange={e => setSetup(e.target.checked)} /><span>{overview.setupScript ? t("运行环境准备脚本（.agentfleet/worktree-setup.sh）") : t("无环境：仓库中没有 .agentfleet/worktree-setup.sh")}</span></label>
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    <button type="submit" className="button button--primary" disabled={busy || !base}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{busy ? t("正在创建工作树…") : t("新建工作树并开始会话")}</button>
  </form>;
}

function LaneCard({ lane, overview, providers, onOpenSession, onChanged }: { lane: WorktreeLane; overview: WorktreeOverview; providers: ProviderId[]; onOpenSession: (id: string) => void; onChanged: () => void }) {
  const [diff, setDiff] = useState<WorktreeDiff>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [joiner, setJoiner] = useState<ProviderId | "">("");
  const laneId = lane.projects[0]!.projectId;
  const running = lane.sessions.some(session => session.running);
  const overlaps = overview.overlaps.filter(item => item.branches.includes(lane.branch));
  const act = (key: string, work: () => Promise<unknown>) => { setBusy(key); setError(""); void work().then(onChanged).catch(reason => setError((reason as Error).message)).finally(() => setBusy("")); };
  const spinner = (key: string, icon: ReactNode) => busy === key ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : icon;
  return <li className="worktree-lane">
    <div className="worktree-lane__head"><strong><GitBranch size={15} aria-hidden="true" /> {lane.branch}</strong>
      <span className="worktree-lane__meta">{t("基于 {0}", lane.base || "?")} · {t("领先 {0} / 落后 {1}", String(lane.ahead), String(lane.behind))}{lane.dirtyFiles ? ` · ${t("{0} 个未提交文件", String(lane.dirtyFiles))}` : ""}</span>
      <code className="worktree-lane__path">{lane.path}</code>
      {lane.lastCommit && <span className="worktree-lane__meta">{t("最近提交：{0}", lane.lastCommit)}</span>}
      {!lane.exists && <span className="catalog-error">{t("工作树目录已不存在")}</span>}</div>
    <div className="worktree-lane__agents">{lane.projects.map(project => <span key={project.projectId} className="worktree-chip">{agentName(project.provider)}</span>)}</div>
    {lane.sessions.length > 0 && <ul className="worktree-lane__sessions">{lane.sessions.map(session => <li key={session.id}><button type="button" className="link-button" onClick={() => onOpenSession(session.id)}>{agentName(session.provider)} · {session.title}</button>{session.running && <span className="worktree-chip worktree-chip--running">{t("运行中")}</span>}</li>)}</ul>}
    {overlaps.length > 0 && <p className="worktree-warning"><AlertTriangle size={14} aria-hidden="true" />{t("与其他工作树改动了相同文件：{0}", overlaps.slice(0, 5).map(item => item.file).join("、"))}</p>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    <div className="worktree-lane__actions">
      <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => diff ? setDiff(undefined) : act("diff", async () => setDiff(await api.worktreeDiff(laneId)))}>{spinner("diff", <GitBranch size={15} aria-hidden="true" />)}{diff ? t("收起差异") : t("查看差异")}</button>
      <button type="button" className="button button--quiet" disabled={Boolean(busy) || running || !lane.ahead || lane.dirtyFiles > 0 || overview.mainDirtyFiles > 0}
        title={lane.dirtyFiles ? t("请先让智能体提交改动") : overview.mainDirtyFiles ? t("主目录有未提交的改动") : !lane.ahead ? t("没有需要合并的新提交") : running ? t("任务运行中") : ""}
        onClick={() => { if (window.confirm(t("把 {0} 的 {1} 个提交合并到 {2}？", lane.branch, String(lane.ahead), overview.current ?? ""))) act("merge", async () => waitForOperation(await api.mergeWorktree(laneId, crypto.randomUUID()))); }}>{spinner("merge", <GitMerge size={15} aria-hidden="true" />)}{t("合并到 {0}", overview.current ?? t("主分支"))}</button>
      <select aria-label={t("让其他智能体加入")} value={joiner} disabled={Boolean(busy)} onChange={e => setJoiner(e.target.value as ProviderId | "")}>
        <option value="">{t("让其他智能体加入…")}</option>{providers.map(id => <option key={id} value={id}>{agentName(id)}</option>)}</select>
      {joiner && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => act("join", async () => { const result = await startLaneSession(overview.project.projectId, overview.project.machineId, { provider: joiner, adoptPath: lane.path, setup: false }, t("{0} · 工作树", agentName(joiner))); onOpenSession(result.sessionId); })}>{spinner("join", <UserPlus size={15} aria-hidden="true" />)}{t("加入并开始会话")}</button>}
      <button type="button" className="button button--danger-quiet" disabled={Boolean(busy) || running} onClick={() => {
        const force = lane.dirtyFiles > 0;
        if (!window.confirm(force ? t("工作树有 {0} 个未提交文件，删除会丢弃这些改动。确定删除 {1}？", String(lane.dirtyFiles), lane.branch) : t("删除工作树 {0}？未合并的分支会保留。", lane.branch))) return;
        act("remove", async () => waitForOperation(await api.removeWorktree(laneId, { deleteBranch: true, force }, crypto.randomUUID())));
      }}>{spinner("remove", <Trash2 size={15} aria-hidden="true" />)}{t("删除")}</button>
    </div>
    {diff && <div className="worktree-diff"><pre>{diff.stat || t("没有已提交的差异")}</pre>{diff.status.length > 0 && <pre>{diff.status.join("\n")}</pre>}<details><summary>{t("完整补丁")}{diff.truncated ? ` (${t("已截断")})` : ""}</summary><pre className="worktree-diff__patch">{diff.patch}</pre></details></div>}
  </li>;
}

/** Parallel lanes for the session's repository: every agent works in its own git worktree, so none waits on another. */
export function ProjectWorktreesPanel({ projectId, machine, onOpenSession }: { projectId: string; machine?: Machine; onOpenSession: (id: string) => void }) {
  const [overview, setOverview] = useState<WorktreeOverview>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [adopting, setAdopting] = useState("");
  const providers = laneProviders(machine);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api.worktrees(projectId, controller.signal).then(setOverview).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    const timer = window.setInterval(() => void api.worktrees(projectId, controller.signal).then(setOverview).catch(() => undefined), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [projectId, reload]);
  const refresh = () => setReload(n => n + 1);
  if (error && !overview) return <div className="worktrees"><p className="catalog-error" role="alert">{systemText(error)}</p><button type="button" className="button button--quiet" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />{t("重试")}</button></div>;
  if (!overview) return <div className="worktrees" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> {t("正在读取工作树…")}</div>;
  return <div className="worktrees">
    <p className="project-tools-description">{t("每个工作树是独立目录和分支，不同智能体可以同时在各自的工作树里执行，互不排队。完成后在这里查看差异并合并回主分支。")}</p>
    <div className="worktrees__repo"><strong>{overview.project.alias}</strong><span>{t("主目录分支：{0}", overview.current ?? t("未检出分支"))}{overview.mainDirtyFiles ? ` · ${t("{0} 个未提交文件", String(overview.mainDirtyFiles))}` : ""}</span>
      <button type="button" className="button button--quiet" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />{t("刷新")}</button></div>
    <h3>{t("新建工作树")}</h3>
    <LaneCreate overview={overview} providers={providers} onCreated={id => { refresh(); onOpenSession(id); }} />
    <h3>{t("工作树（{0}）", String(overview.lanes.length))}</h3>
    {overview.lanes.length ? <ul className="worktree-list">{overview.lanes.map(lane => <LaneCard key={lane.path} lane={lane} overview={overview} providers={providers} onOpenSession={onOpenSession} onChanged={refresh} />)}</ul> : <p className="host-help">{t("还没有工作树。")}</p>}
    {overview.unmanaged.length > 0 && <><h3>{t("其他工作树")}</h3><p className="host-help">{t("这些工作树由 Codex 桌面版或手动创建，可以接入面板后让智能体在其中工作。")}</p>
      <ul className="worktree-list">{overview.unmanaged.map(item => <li key={item.path} className="worktree-lane"><div className="worktree-lane__head"><strong><GitBranch size={15} aria-hidden="true" /> {item.branch ?? t("未检出分支")}</strong><code className="worktree-lane__path">{item.path}</code></div>
        {item.branch && <div className="worktree-lane__actions">{providers.map(id => <button key={id} type="button" className="button button--quiet" disabled={Boolean(adopting)} onClick={() => { setAdopting(item.path); void startLaneSession(overview.project.projectId, overview.project.machineId, { provider: id, adoptPath: item.path, setup: false }, t("{0} · 工作树", agentName(id))).then(result => { refresh(); onOpenSession(result.sessionId); }).catch(reason => setError((reason as Error).message)).finally(() => setAdopting("")); }}>{adopting === item.path ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <UserPlus size={15} aria-hidden="true" />}{t("用 {0} 接入", agentName(id))}</button>)}</div>}</li>)}</ul></>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
  </div>;
}

const OPEN_ALL = { section: "all", nonce: 0 } as const;

/** Toolbar entry shown for every agent's session. */
export function ProjectWorktrees({ projectId, title, machine, onOpenSession }: { projectId: string; title: string; machine?: Machine; onOpenSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="button button--quiet session-config-trigger" aria-label={t("工作树")} title={t("工作树")} aria-haspopup="dialog" onClick={() => setOpen(true)}><GitBranch size={18} /><span className="buzhou-full-label">{t("工作树")}</span></button>
    {open && createPortal(<SessionConfiguration request={OPEN_ALL} heading={t("工作树")} closeLabel={t("关闭工作树")} title={title} onClose={() => setOpen(false)}>
      <ProjectWorktreesPanel projectId={projectId} machine={machine} onOpenSession={id => { setOpen(false); onOpenSession(id); }} />
    </SessionConfiguration>, document.body)}</>;
}
