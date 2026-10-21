import { AlertTriangle, GitBranch, GitMerge, LoaderCircle, Plus, RefreshCw, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { agentName } from "../lib/agent-provider";
import { PROVIDER_IDS, type ProviderId } from "../lib/provider-catalog";
import { startLaneSession, waitForOperation } from "../lib/worktrees";
import { t, systemText } from "../i18n";
import type { Machine, WorktreeDiff, WorktreeLane, WorktreeOverview } from "../lib/types";
import { WorktreeFields, worktreeBranchError, worktreeBranchInput, type WorktreeDraft } from "./WorktreeFields";
import { SessionConfiguration } from "./SessionConfiguration";

/** Agents this host can run; Codex is always present, others when their CLI was found. */
export function laneProviders(machine?: Machine): ProviderId[] {
  return PROVIDER_IDS.filter(id => id === "codex" || (id === "claude" ? machine?.agentRuntimes?.claude?.installed === true : machine?.agentRuntimes?.[id]?.installed === true));
}

interface CurrentSession { id: string; title: string; provider: ProviderId }

function LaneCreate({ overview, providers, initialProvider, onCreated }: { overview: WorktreeOverview; providers: ProviderId[]; initialProvider?: ProviderId; onCreated: (sessionId: string) => void }) {
  const [provider, setProvider] = useState<ProviderId>(initialProvider && providers.includes(initialProvider) ? initialProvider : providers[0] ?? "codex");
  const [draft, setDraft] = useState<WorktreeDraft>({ branch: "", base: overview.current ?? overview.branches[0] ?? "", setup: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const branchError = worktreeBranchError(overview, draft.branch);
  return <form className="stack-form worktree-create" onSubmit={event => {
    event.preventDefault(); if (busy || branchError || !draft.base) return; setBusy(true); setError("");
    void startLaneSession(overview.project.projectId, overview.project.machineId, { provider, ...worktreeBranchInput(overview, draft.branch), base: draft.base, setup: draft.setup }, t("{0} · 工作树", agentName(provider)))
      .then(result => onCreated(result.sessionId)).catch(reason => setError((reason as Error).message)).finally(() => setBusy(false));
  }}>
    <label><span>{t("新会话的智能体")}</span><select disabled={busy} value={provider} onChange={e => setProvider(e.target.value as ProviderId)}>{providers.map(id => <option key={id} value={id}>{agentName(id)}</option>)}</select></label>
    <WorktreeFields overview={overview} value={draft} onChange={setDraft} disabled={busy} />
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    <button type="submit" className="button button--primary" disabled={busy || !draft.base || Boolean(branchError)}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{busy ? t("正在创建工作树…") : t("创建工作树和新会话")}</button>
  </form>;
}

function LaneCard({ lane, overview, providers, initialProvider, currentSessionId, onOpenSession, onChanged }: { initialProvider?: ProviderId; currentSessionId?: string; lane: WorktreeLane; overview: WorktreeOverview; providers: ProviderId[]; onOpenSession: (id: string) => void; onChanged: () => void }) {
  const [diff, setDiff] = useState<WorktreeDiff>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [joiner, setJoiner] = useState<ProviderId | "">(initialProvider && providers.includes(initialProvider) ? initialProvider : "");
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
    {lane.sessions.length > 0 && <ul className="worktree-lane__sessions">{lane.sessions.map(session => <li key={session.id}><button type="button" className="link-button" onClick={() => onOpenSession(session.id)}>{t("打开会话：{0}", `${agentName(session.provider)} · ${session.title}`)}</button>{session.id === currentSessionId && <span className="worktree-chip">{t("当前会话")}</span>}{session.running && <span className="worktree-chip worktree-chip--running">{t("运行中")}</span>}</li>)}</ul>}
    {overlaps.length > 0 && <p className="worktree-warning"><AlertTriangle size={14} aria-hidden="true" />{t("与其他工作树改动了相同文件：{0}", overlaps.slice(0, 5).map(item => item.file).join("、"))}</p>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    <div className="worktree-lane__actions">
      <select aria-label={t("新会话的智能体")} value={joiner} disabled={Boolean(busy)} onChange={e => setJoiner(e.target.value as ProviderId | "")}>
        <option value="">{t("选择智能体新建会话…")}</option>{providers.map(id => <option key={id} value={id}>{agentName(id)}</option>)}</select>
      {joiner && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => act("join", async () => { const result = await startLaneSession(overview.project.projectId, overview.project.machineId, { provider: joiner, adoptPath: lane.path, setup: false }, t("{0} · 工作树", agentName(joiner))); onOpenSession(result.sessionId); })}>{spinner("join", <UserPlus size={15} aria-hidden="true" />)}{t("在此工作树新建会话")}</button>}

    </div>
    <details className="worktree-management"><summary>{t("查看改动、合并或删除")}</summary><div className="worktree-lane__actions">
      <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => diff ? setDiff(undefined) : act("diff", async () => setDiff(await api.worktreeDiff(laneId)))}>{spinner("diff", <GitBranch size={15} aria-hidden="true" />)}{diff ? t("收起差异") : t("查看差异")}</button>
      <button type="button" className="button button--quiet" disabled={Boolean(busy) || running || !lane.ahead || lane.dirtyFiles > 0 || overview.mainDirtyFiles > 0}
        title={lane.dirtyFiles ? t("请先让智能体提交改动") : overview.mainDirtyFiles ? t("主目录有未提交的改动") : !lane.ahead ? t("没有需要合并的新提交") : running ? t("任务运行中") : ""}
        onClick={() => { if (window.confirm(t("把 {0} 的 {1} 个提交合并到 {2}？", lane.branch, String(lane.ahead), overview.current ?? ""))) act("merge", async () => waitForOperation(await api.mergeWorktree(laneId, crypto.randomUUID()))); }}>{spinner("merge", <GitMerge size={15} aria-hidden="true" />)}{t("合并到 {0}", overview.current ?? t("主分支"))}</button>
      <button type="button" className="button button--danger-quiet" disabled={Boolean(busy) || running} onClick={() => {
        const force = lane.dirtyFiles > 0;
        if (!window.confirm(force ? t("工作树有 {0} 个未提交文件，删除会丢弃这些改动。确定删除 {1}？", String(lane.dirtyFiles), lane.branch) : t("删除工作树 {0}？未合并的分支会保留。", lane.branch))) return;
        act("remove", async () => waitForOperation(await api.removeWorktree(laneId, { deleteBranch: true, force }, crypto.randomUUID())));
      }}>{spinner("remove", <Trash2 size={15} aria-hidden="true" />)}{t("删除")}</button>
    </div></details>
    {diff && <div className="worktree-diff"><pre>{diff.stat || t("没有已提交的差异")}</pre>{diff.status.length > 0 && <pre>{diff.status.join("\n")}</pre>}<details><summary>{t("完整补丁")}{diff.truncated ? ` (${t("已截断")})` : ""}</summary><pre className="worktree-diff__patch">{diff.patch}</pre></details></div>}
  </li>;
}

/** Keep session navigation separate from creating another session or changing Git files. */
export function ProjectWorktreesPanel({ projectId, machine, currentSession, onOpenSession }: { projectId: string; machine?: Machine; currentSession?: CurrentSession; onOpenSession: (id: string) => void }) {
  const [overview, setOverview] = useState<WorktreeOverview>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [adopting, setAdopting] = useState("");
  const [section, setSection] = useState<"create" | "existing">("create");
  const providers = laneProviders(machine);
  const initialProvider = currentSession?.provider && providers.includes(currentSession.provider) ? currentSession.provider : providers[0] ?? "codex";
  const [adoptProvider, setAdoptProvider] = useState<ProviderId>(initialProvider);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try { const info = await api.worktrees(projectId, controller.signal); if (!controller.signal.aborted) { setOverview(info); setError(""); } }
      catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(read, 10_000); }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, reload]);
  const refresh = () => setReload(n => n + 1);
  if (error && !overview) return <div className="worktrees"><p className="catalog-error" role="alert">{systemText(error)}</p><button type="button" className="button button--quiet" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />{t("重试")}</button></div>;
  if (!overview) return <div className="worktrees" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> {t("正在读取工作树…")}</div>;
  const currentLane = overview.lanes.find(lane => lane.projects.some(project => project.projectId === projectId));
  return <div className="worktrees">
    <div className="worktree-current">
      <strong>{currentSession ? t("当前会话：{0}", currentSession.title) : overview.project.alias}</strong>
      <span>{t("当前分支：{0}", currentLane?.branch ?? overview.current ?? t("未检出分支"))}</span>
      <code>{currentLane?.path ?? overview.project.root}</code>
      <p>{t("新建工作树会创建独立目录和新会话。当前会话、历史和未提交改动留在原处，新会话不会自动继承对话上下文。")}</p>
    </div>
    <div className="worktree-choices" role="group" aria-label={t("选择工作树操作")}>
      <button type="button" aria-pressed={section === "create"} onClick={() => setSection("create")}>{t("新建独立会话")}</button>
      <button type="button" aria-pressed={section === "existing"} onClick={() => setSection("existing")}>{t("使用已有工作树（{0}）", String(overview.lanes.length + overview.unmanaged.length))}</button>
    </div>
    {section === "create" ? <LaneCreate overview={overview} providers={providers} initialProvider={initialProvider} onCreated={id => { refresh(); onOpenSession(id); }} /> : <>
      <p className="host-help">{t("打开已有会话会保留该会话的历史；在工作树中新建会话会从空白对话开始。")}</p>
      <button type="button" className="button button--quiet" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />{t("刷新")}</button>
      {overview.lanes.length > 0 && <ul className="worktree-list">{overview.lanes.map(lane => <LaneCard key={lane.path} lane={lane} overview={overview} providers={providers} initialProvider={initialProvider} currentSessionId={currentSession?.id} onOpenSession={onOpenSession} onChanged={refresh} />)}</ul>}
      {!overview.lanes.length && !overview.unmanaged.length && <p className="host-help">{t("还没有工作树。选择“新建独立会话”即可创建。")}</p>}
      {overview.unmanaged.length > 0 && <><h3>{t("主机上的其他工作树")}</h3><p className="host-help">{t("这些目录已存在于主机上。选一个目录创建新会话，不会移动当前会话。")}</p>
        <label className="stack-form"><span>{t("新会话的智能体")}</span><select disabled={Boolean(adopting)} value={adoptProvider} onChange={e => setAdoptProvider(e.target.value as ProviderId)}>{providers.map(id => <option key={id} value={id}>{agentName(id)}</option>)}</select></label>
        <ul className="worktree-list">{overview.unmanaged.map(item => <li key={item.path} className="worktree-lane"><div className="worktree-lane__head"><strong><GitBranch size={15} aria-hidden="true" /> {item.branch ?? t("未检出分支")}</strong><code className="worktree-lane__path">{item.path}</code></div>
          {item.branch && <button type="button" className="button button--quiet" disabled={Boolean(adopting)} onClick={() => { setAdopting(item.path); void startLaneSession(overview.project.projectId, overview.project.machineId, { provider: adoptProvider, adoptPath: item.path, setup: false }, t("{0} · 工作树", agentName(adoptProvider))).then(result => { refresh(); onOpenSession(result.sessionId); }).catch(reason => setError((reason as Error).message)).finally(() => setAdopting("")); }}>{adopting === item.path ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <UserPlus size={15} aria-hidden="true" />}{t("在此新建 {0} 会话", agentName(adoptProvider))}</button>}</li>)}</ul></>}
    </>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
  </div>;
}

const OPEN_ALL = { section: "all", nonce: 0 } as const;

/** Toolbar entry shown for every agent's session. */
export function ProjectWorktrees({ projectId, title, machine, currentSession, onOpenSession }: { currentSession?: CurrentSession; projectId: string; title: string; machine?: Machine; onOpenSession: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="button button--quiet session-config-trigger" aria-label={t("工作树")} title={t("工作树")} aria-haspopup="dialog" onClick={() => setOpen(true)}><GitBranch size={18} /><span className="buzhou-full-label">{t("工作树")}</span></button>
    {open && createPortal(<SessionConfiguration request={OPEN_ALL} heading={t("工作树")} closeLabel={t("关闭工作树")} title={title} onClose={() => setOpen(false)}>
      <ProjectWorktreesPanel projectId={projectId} machine={machine} currentSession={currentSession} onOpenSession={id => { setOpen(false); onOpenSession(id); }} />
    </SessionConfiguration>, document.body)}</>;
}
