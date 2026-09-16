import { writingAIErrorMessage } from "./lib/writing-assistance";
import { WorldClocks } from "./components/WorldClocks";
import { hasLiveTransport, onlineFirst } from "./lib/machine-order";
import { MarkdownMessage } from "./components/MarkdownMessage";
import { SessionActions } from "./components/SessionActions";
import { useMobileViewport } from "./lib/mobile-viewport";
import { ATTACHMENT_ACCEPT, useFileDraft } from "./lib/file-drafts";
import { RuntimeSettingsShortcut } from "./components/RuntimeSettingsShortcut";
import type { RuntimeSummary } from "./components/CodexSettingsPanel";
import { UsageButton } from "./components/UsageButton";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ThemeEmblem, ThemeSwitcher } from "./components/ThemeSwitcher";
import { count, t, locale, systemText, useLocale } from "./i18n";
import { SessionConfiguration, type ConfigurationRequest } from "./components/SessionConfiguration";
import { FleetStatus } from "./components/FleetStatus";
import { SettingsView } from "./components/SettingsView";
import { UsageView } from "./components/UsageView";
import { NativeSessionDeletion } from "./components/NativeSessionDeletion";
import { CommandRecovery } from "./components/CommandRecovery";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  FileDiff,
  FolderGit2,
  FolderOpen,
  FileUp,
  GitBranch,
  ImagePlus,
  Lightbulb,
  Paperclip,
  Puzzle,
  Target,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  MonitorDot,
  OctagonX,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Radio,
  Send,
  Server,
  Settings2,
  Share2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Unplug,
  UserRoundCheck,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeToFleet } from "./lib/api";
import type { VolatileUpdate } from "./lib/api";
import { PairMachineDialog } from "./components/PairMachineDialog";
import { SessionRecovery } from "./components/SessionRecovery";
import { OperationReceipts, commandPending } from "./components/OperationReceipts";
import { WorkspaceCatalog } from "./components/WorkspaceCatalog";
import { HostsView } from "./components/HostsView";
import { DiscoveryStatus } from "./components/DiscoveryStatus";
import { CodexSettingsPanel, type RuntimeChoice } from "./components/CodexSettingsPanel";
import { PermissionPanel } from "./components/PermissionPanel";
import { CommandExecution } from "./components/CommandExecution";
import { MessageImages } from "./components/MessageImages";
import { useImageDraft } from "./lib/image-drafts";
import { timelineItems } from "./lib/timeline-items";
import { pageItems } from "./lib/pagination";
import { commandMutationId, mergeCommandReceipts, rememberCommandReceipt } from "./lib/command-mutation";
import { ConversationViewport } from "./components/ConversationViewport";
import { CodexInputCard } from "./components/CodexInputCard";
import { NativeSessionActions, type NativeOperation } from "./components/NativeSessionActions";
import { CodexInspectionPanel } from "./components/CodexInspectionPanel";
import type { CodexSettings } from "./lib/codex-settings";
import { codexCommands, coverageLabels, initInstructions, parseCodexCommand } from "./lib/codex-commands";
import { CodexCommandGuide } from "./components/CodexCommandGuide";
import { sessionPath, useSessionDraft } from "./lib/session-workspace";
import { useAutoSizeTextarea } from "./lib/auto-size-textarea";
import { useCompletionPreferences } from "./lib/completion-preferences";
import { useWritingMemory } from "./lib/writing-assistance";
import { mergeWritingSuggestions, useChineseNLP } from "./lib/writing-nlp";
import { CompletionSurface } from "./components/CompletionSurface";
import { SessionWritingPreferencesPanel } from "./components/WritingPreferencesPanel";
import { applyPromptCompletion, pluginCompletions, promptCompletions, type PromptCompletion } from "./lib/prompt-completions";
import { routeFromPath, routePath, type AppRoute, type View } from "./lib/navigation";
import type {
  Approval,
  CodexCompatibilityProfile,
  Dashboard,
  FleetSession,
  Machine,
  Project,
  SessionDetail,
  TimelineEvent,
} from "./lib/types";
import { ApiError } from "./lib/types";

type Toast = { id: string; tone: "info" | "success" | "danger"; message: string };
const PROJECTS_PER_PAGE = 8;
const CATALOG_COLLAPSED_KEY = "agentfleet:workbench:catalog-collapsed";



function timeAgo(value?: string | null) {
  const relativeTime = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  if (!value) return t("从未连接");
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return relativeTime.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return relativeTime.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return relativeTime.format(Math.round(diff / 3_600_000), "hour");
  return relativeTime.format(Math.round(diff / 86_400_000), "day");
}

function shortId(value?: string | null) {
  if (!value) return "—";
  return value.length > 13 ? `${value.slice(0, 7)}…${value.slice(-4)}` : value;
}

function normalizedSchemaHash(value?: string | null) {
  return value?.toLowerCase().replace(/^sha256:/, "") ?? "";
}

function shortSchemaHash(value?: string | null) {
  const normalized = normalizedSchemaHash(value);
  return normalized ? `${normalized.slice(0, 10)}…${normalized.slice(-8)}` : t("未上报");
}

function validationTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("尚未发布");
  return `${new Intl.DateTimeFormat(locale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(timestamp)} UTC`;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return t("操作未完成，请重试");
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error(t("浏览器未允许复制，请手动选中命令"));
}

function volatileDiff(value: string): TimelineEvent["diff"] {
  if (!value) return null;
  const lines = value.split("\n");
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    files: new Set(lines.filter((line) => line.startsWith("diff --git "))).size || 1,
  };
}

function StatusDot({ tone = "muted", pulse = false }: { tone?: "live" | "warning" | "danger" | "muted"; pulse?: boolean }) {
  return <span className={`status-dot status-dot--${tone}${pulse ? " status-dot--pulse" : ""}`} aria-hidden="true" />;
}

function IconButton({ label, children, onClick, className = "", disabled = false, type = "button" }: { label: string; children: ReactNode; onClick?: () => void; className?: string; disabled?: boolean; type?: "button" | "submit" }) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} type={type} disabled={disabled}>
      {children}
    </button>
  );
}

function Login({ onLogin }: { onLogin: (dashboard: Dashboard) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api.login(email, password);
      onLogin(result.dashboard);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <div className="login-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <section className="login-copy">
        <div className="login-preferences"><LanguageSwitcher /><ThemeSwitcher /></div>
        <div className="brand-lockup brand-lockup--large">
          <span className="brand-glyph"><ThemeEmblem /></span>
          <span>AgentFleets for Codex</span>
        </div>
        <h1>{t("你的代码留在主机。")}<br />{t("控制权跟你走。")}</h1>
        <p>{t("统一连接 Linux、macOS 与 Windows 上的 Codex。切换主机，接管会话，从任何地方继续你的开发任务。")}</p>
        <div className="trust-line">
          <span><ShieldCheck size={16} /> {t("权限按需配置")}</span>
          <span><LockKeyhole size={16} /> {t("无入站端口")}</span>
          <span><Clock3 size={16} /> {t("正文保留 1–30 天")}</span>
        </div>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="eyebrow">{t("Codex · 多主机控制台")}</div>
        <h2 id="login-title">{t("进入控制面")}</h2>
        <p className="subtle">{t("使用部署时设置的管理员账号。")}</p>
        <form onSubmit={submit}>
          <label>
            <span>{t("邮箱")}</span>
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
          </label>
          <label>
            <span>{t("密码")}</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <div className="form-error" role="alert"><AlertTriangle size={15} />{systemText(error)}</div>}
          <button className="button button--primary login-submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
            {busy ? t("正在验证") : t("进入 AgentFleets")}
          </button>
        </form>
        <div className="login-foot"><StatusDot tone="live" /> {t("受控登录 · 会话可单独撤销")}</div>
      </section>
    </main>
  );
}

function MachineRail({ machines, sessions, connected, selectedId, onSelect, onPair, onSession, onHost }: { machines: Machine[]; sessions: FleetSession[]; connected: boolean; selectedId?: string; onSelect: (id: string) => void; onPair: () => void; onSession: (id: string) => void; onHost: (id: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reveal = () => {
      const list = track.current;
      const active = list?.querySelector<HTMLElement>(".machine-link--active");
      if (list && active && list.scrollWidth > list.clientWidth) {
        list.scrollLeft = active.offsetLeft - list.clientWidth / 2 + active.clientWidth / 2;
      }
    };
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [selectedId]);
  return (
    <aside className="machine-rail">
      <div className="rail-heading">
        <div>
          <div className="eyebrow">{t("已连接的设备")}</div>
          <h2>{t("我的主机")}</h2>
        </div>
        <IconButton label={t("配对新主机")} onClick={onPair}><Plus size={17} /></IconButton>
      </div>
      <div ref={track} className="rail-track" aria-label={t("已配对主机")}>
        {machines.length === 0 ? (
          <button className="rail-empty" onClick={onPair} type="button">
            <span className="rail-node rail-node--empty"><Plus size={15} /></span>
            <strong>{t("连接第一台主机")}</strong>
            <small>Linux · macOS · Windows</small>
          </button>
        ) : onlineFirst(machines).map((machine) => {
          const live = machine.reachability === "live";
          const transportConnected = hasLiveTransport(machine);
          const warning = machine.compatibility !== "compatible";
          return (
            <button
              type="button"
              key={machine.id}
              className={`machine-link${selectedId === machine.id ? " machine-link--active" : ""}`}
              aria-pressed={selectedId === machine.id}
              onClick={() => onSelect(machine.id)}
            >
              <span className={`rail-node${transportConnected ? " rail-node--live" : ""}${live && (machine.capacity === "busy" || machine.capacity === "saturated") ? " rail-node--running" : ""}`}><Server size={15} /></span>
              <span className="machine-link__copy">
                <strong>{machine.name}</strong>
                <small>{live ? machine.capacity === "busy" || machine.capacity === "saturated" ? t("正在执行") : t("在线可用") : machine.reachability === "reconciling" ? t("正在同步") : machine.reachability === "reconnecting" ? t("正在重连") : t("不可达 · {0}", timeAgo(machine.lastSeenAt))}</small>
              </span>
              {warning ? <AlertTriangle className="machine-warning" size={15} /> : <StatusDot tone={transportConnected ? "live" : "muted"} pulse={live && (machine.capacity === "busy" || machine.capacity === "saturated")} />}
            </button>
          );
        })}
      </div>
      <div className="rail-footer">
        <FleetStatus machines={machines} sessions={sessions} connected={connected} onSession={onSession} onMachine={onHost} utility={<ThemeSwitcher />} />
      </div>
    </aside>
  );
}

export function CompatibilityProfileCard({ machine, profile }: { machine: Machine; profile: CodexCompatibilityProfile }) {
  const schemaMatches = normalizedSchemaHash(machine.schemaHash) !== "" &&
    normalizedSchemaHash(machine.schemaHash) === normalizedSchemaHash(profile.schemaHash);
  const compatible = machine.compatibility === "compatible" && schemaMatches && profile.validationStatus === "verified";
  const pending = machine.compatibility === "unknown" || profile.validationStatus === "unknown";
  const tone = compatible ? "verified" : pending ? "pending" : "blocked";
  const title = compatible ? t("兼容档案已验证") : pending ? t("等待兼容验证") : t("未通过兼容验证");
  const summary = compatible
    ? t("Agent 实际使用的运行时与控制面固定档案一致，远程写入已启用。")
    : machine.compatibilityReason ?? t("Agent 运行时尚未与控制面兼容档案匹配。");
  const [evidenceOpen, setEvidenceOpen] = useState(!compatible);
  useEffect(() => setEvidenceOpen(!compatible), [machine.id, compatible, profile.profileVersion]);

  return (
    <section className={`compatibility-card compatibility-card--${tone}`} aria-label={t("Codex 兼容档案")}>
      <div className="compatibility-card__head">
        <span className="compatibility-card__seal">
          {compatible ? <ShieldCheck size={19} /> : <AlertTriangle size={18} />}
        </span>
        <div className="compatibility-card__copy">
          <div className="compatibility-card__title"><strong>{title}</strong><span>{profile.profileVersion}</span></div>
          <p>{summary}</p>
        </div>
        <div className="compatibility-card__stamp">
          <span>{t("最后验证")}</span>
          <strong>{validationTime(profile.lastValidatedAt)}</strong>
        </div>
      </div>
      <div className="schema-trace" aria-label={schemaMatches ? t("Agent schema 与控制面档案一致") : t("Agent schema 与控制面档案不一致")}>
        <div className="schema-trace__endpoint">
          <span>{t("Agent 实际使用")}</span>
          <strong>Codex {machine.codexVersion}</strong>
          <code title={machine.schemaHash ?? undefined}>{shortSchemaHash(machine.schemaHash)}</code>
        </div>
        <div className={`schema-trace__link schema-trace__link--${schemaMatches ? "match" : "mismatch"}`}>
          <span />
          {schemaMatches ? <Check size={14} /> : <AlertTriangle size={14} />}
          <span />
          <small>{schemaMatches ? t("SHA-256 一致") : t("SHA-256 不一致")}</small>
        </div>
        <div className="schema-trace__endpoint schema-trace__endpoint--target">
          <span>{t("托管目标")}</span>
          <strong>Codex {profile.managedCodexVersion}</strong>
          <code title={profile.schemaHash}>{shortSchemaHash(profile.schemaHash)}</code>
        </div>
      </div>
      <p className="compatibility-card__runtime-note">
        {t("此处显示 AgentFleets 实际使用的 Codex。来源为宿主机时会直接使用本机程序；来源为托管时使用独立运行时，两者版本可以不同。")}</p>
      <details className="compatibility-evidence" open={evidenceOpen} onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}>
        <summary>{t("查看验证依据")}<ChevronRight size={15} /></summary>
        <dl>
          <div><dt>Agent App Server schema</dt><dd><code>{machine.schemaHash || t("未上报")}</code></dd></div>
          <div><dt>{t("控制面期望 schema")}</dt><dd><code>sha256:{normalizedSchemaHash(profile.schemaHash) || t("未发布")}</code></dd></div>
          <div><dt>{t("版本范围")}</dt><dd>Codex ≥ {profile.minimumCodexVersion}{locale() === "en" ? " " : ""}{t("，且 schema 必须完全一致")}</dd></div>
          <div><dt>{t("自动升级规则")}</dt><dd>{t("仅在新版本验证通过并晋升为托管目标后自动切换")}</dd></div>
          <div><dt>{t("主机最近核验")}</dt><dd>{timeAgo(machine.lastSeenAt)}</dd></div>
        </dl>
      </details>
    </section>
  );
}

export function MachineSummaryHeader({ machine, onAliasChange }: {
  machine: Machine;
  onAliasChange: (alias: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(machine.displayAlias ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEditing(false);
    setDraft(machine.displayAlias ?? "");
  }, [machine.id, machine.displayAlias]);

  async function saveAlias(event: FormEvent) {
    event.preventDefault();
    const alias = draft.trim();
    setBusy(true);
    try {
      await onAliasChange(alias && alias !== machine.hostname ? alias : null);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="machine-summary">
      <div className="machine-summary__identity">
        <span className="machine-os">{machine.os} · {machine.arch}</span>
        {editing ? (
          <form className="machine-alias-form" onSubmit={(event) => void saveAlias(event)}>
            <input aria-label={t("主机显示名称")} value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} placeholder={machine.hostname} autoFocus />
            <IconButton label={t("保存主机名称")} type="submit" disabled={busy}><Check size={15} /></IconButton>
            <IconButton label={t("取消修改")} disabled={busy} onClick={() => { setDraft(machine.displayAlias ?? ""); setEditing(false); }}><X size={15} /></IconButton>
          </form>
        ) : (
          <div className="machine-name-line">
            <h1>{machine.name}</h1>
            <IconButton label={t("修改主机显示名称")} onClick={() => setEditing(true)}><Pencil size={14} /></IconButton>
          </div>
        )}
        {machine.displayAlias && <span className="machine-hostname">hostname · {machine.hostname}</span>}
      </div>
      <div className="machine-summary__actions">
        <UsageButton scope="machine" id={machine.id}/>
        <div className="machine-summary__facts"><span><GitBranch size={14} />{count(machine.discovery?.discoveredProjects ?? machine.projects.length, "个项目")} </span><span>{machine.reachability === "live" ? t("在线") : machine.reachability === "reconciling" ? t("正在同步") : machine.reachability === "reconnecting" ? t("正在重连") : t("等待连接")}</span></div>
      </div>
    </section>
  );
}


function StatePill({ session }: { session: FleetSession }) {
  const { state } = session;
  if (state.unknownFreeze) return <span className="state-pill state-pill--danger"><AlertTriangle size={13} />{t("结果待核验")}</span>;
  if (state.waitReason === "approval") return <span className="state-pill state-pill--warning"><KeyRound size={13} />{t("等待确认")}</span>;
  if (state.waitReason === "user_input") return <span className="state-pill state-pill--warning"><MessageSquareText size={13} />{t("等待回答")}</span>;
  if (state.currentTurn === "in_progress") return <span className="state-pill state-pill--live"><Activity size={13} />{t("执行中")}</span>;
  if (state.reachability === "unreachable") return <span className="state-pill"><Unplug size={13} />{t("主机不可达")}</span>;
  if (state.threadRuntime === "idle") return <span className="state-pill"><CircleDot size={13} />{t("空闲")}</span>;
  return <span className="state-pill">{{ none: t("尚未开始"), in_progress: t("执行中"), completed: t("已完成"), interrupted: t("已停止"), failed: t("未完成"), unknown: t("状态待确认") }[state.currentTurn]}</span>;
}

export function SessionList({ sessions, projects, selectedId, machineId, onSelect, onCreate }: { sessions: FleetSession[]; projects: Project[]; selectedId?: string; machineId?: string; onSelect: (id: string) => void; onCreate: () => void }) {
  const visible = machineId ? sessions.filter((session) => session.machineId === machineId) : sessions;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [projectPage, setProjectPage] = useState(0);
  const selectedProjectId = selectedId === undefined
    ? undefined
    : sessions.find((session) => session.id === selectedId)?.projectId;
  const groups = useMemo(() => {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const grouped = new Map<string, FleetSession[]>();
    for (const session of visible) grouped.set(session.projectId, [...(grouped.get(session.projectId) ?? []), session]);
    return [...grouped.entries()].map(([projectId, projectSessions]) => ({
      projectId,
      project: projectsById.get(projectId),
      sessions: projectSessions.sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)),
      latest: Math.max(...projectSessions.map((session) => Date.parse(session.lastActivityAt))),
    })).sort((left, right) => right.latest - left.latest);
  }, [projects, visible]);
  const totalProjectPages = Math.max(1, Math.ceil(groups.length / PROJECTS_PER_PAGE));
  const safeProjectPage = Math.min(projectPage, totalProjectPages - 1);
  const projectPageStart = safeProjectPage * PROJECTS_PER_PAGE;
  const pagedGroups = groups.slice(projectPageStart, projectPageStart + PROJECTS_PER_PAGE);
  const selectedProjectIndex = selectedProjectId === undefined
    ? -1
    : groups.findIndex((group) => group.projectId === selectedProjectId);
  useEffect(() => {
    setProjectPage(0);
    setExpandedProjects(new Set());
  }, [machineId]);
  useEffect(() => {
    if (projectPage < totalProjectPages) return;
    setProjectPage(totalProjectPages - 1);
  }, [projectPage, totalProjectPages]);
  useEffect(() => {
    if (selectedProjectId === undefined) return;
    setExpandedProjects((current) => {
      if (current.has(selectedProjectId)) return current;
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
    if (selectedProjectIndex >= 0) setProjectPage(Math.floor(selectedProjectIndex / PROJECTS_PER_PAGE));
  }, [selectedId, selectedProjectId, selectedProjectIndex]);
  return (
    <section className="session-list-panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Codex workspace</div>
          <h2>{machineId ? t("项目与会话") : t("所有项目与会话")}</h2>
        </div>
        <button className="button button--quiet" type="button" onClick={onCreate}><Plus size={15} />{t("新会话")}</button>
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__glyph"><MessageSquareText size={24} /></div>
          <h3>{t("还没有发现 Codex 会话")}</h3>
          <p>{t("主机配对成功后，Agent 会自动读取 Codex 会话并按项目归类；也可以立即创建一个新会话。")}</p>
          <button className="button button--primary" type="button" onClick={onCreate}>{t("创建会话")}</button>
        </div>
      ) : (
        <div className="project-session-list">
          {pagedGroups.map((group) => {
            const collapsed = !expandedProjects.has(group.projectId);
            const sessionListId = `project-sessions-${group.projectId}`;
            return (
              <section className={`project-session-group${collapsed ? " project-session-group--collapsed" : ""}`} key={group.projectId}>
                <button
                  type="button"
                  className="project-session-group__heading"
                  aria-expanded={!collapsed}
                  aria-controls={sessionListId}
                  onClick={() => setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(group.projectId)) next.delete(group.projectId);
                    else next.add(group.projectId);
                    return next;
                  })}
                >
                  <span className="project-session-group__icon"><FolderGit2 size={16} /></span>
                  <span className="project-session-group__copy"><strong>{group.project?.alias ?? group.sessions[0]?.projectAlias ?? t("未知项目")}</strong><span>{group.project?.pathHint ?? t("项目路径未上报")}</span></span>
                  {group.project?.gitBranch && <span className="project-branch"><GitBranch size={11} />{group.project.gitBranch}</span>}
                  <span className="project-session-count">{count(group.sessions.length, "个会话")} </span>
                  <ChevronRight className="project-session-toggle" size={17} aria-hidden="true" />
                </button>
                {!collapsed && <div className="session-list" id={sessionListId}>
                  {group.sessions.map((session) => (
                    <button type="button" key={session.id} className={`session-row${selectedId === session.id ? " session-row--active" : ""}`} onClick={() => onSelect(session.id)}>
                      <div className="session-row__top">
                        <strong>{session.title}</strong>
                        <span className="session-time">{timeAgo(session.lastActivityAt)}</span>
                      </div>
                      <div className="session-row__meta"><span>{session.machineName}</span><span>·</span><span className="mono">{shortId(session.nativeThreadId)}</span></div>
                      <div className="session-row__bottom"><StatePill session={session} /><span className={`history-mark history-mark--${session.state.history}`}>{session.state.history.replace("_", " ")}</span></div>
                      <ChevronRight className="row-chevron" size={17} />
                    </button>
                  ))}
                </div>}
              </section>
            );
          })}
          {totalProjectPages > 1 && (
            <nav className="project-pagination" aria-label={t("项目分页")}>
              <span className="project-pagination__range">
                {projectPageStart + 1}–{Math.min(projectPageStart + PROJECTS_PER_PAGE, groups.length)} / {count(groups.length, "个项目")} </span>
              <span className="project-pagination__actions">
                <button type="button" aria-label={t("上一页")} disabled={safeProjectPage === 0} onClick={() => setProjectPage((page) => Math.max(0, page - 1))}><ChevronLeft size={16} /></button>
                {pageItems(safeProjectPage + 1, totalProjectPages).map((item, index) => item === "ellipsis"
                  ? <span className="project-pagination__ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>
                  : <button type="button" className="project-pagination__number" key={item} aria-current={item === safeProjectPage + 1 ? "page" : undefined} aria-label={t("第 {0} 页", item)} onClick={() => setProjectPage(item - 1)}>{item}</button>)}
                <button type="button" aria-label={t("下一页")} disabled={safeProjectPage >= totalProjectPages - 1} onClick={() => setProjectPage((page) => Math.min(totalProjectPages - 1, page + 1))}><ChevronRight size={16} /></button>
              </span>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}

function EventIcon({ event }: { event: TimelineEvent }) {
  if (event.type.includes("diff") || event.diff) return <FileDiff size={15} />;
  if (event.type.includes("command")) return <TerminalSquare size={15} />;
  if (event.type.includes("approval")) return <KeyRound size={15} />;
  if (event.actor === "agent") return <Code2 size={15} />;
  if (event.actor === "user") return <MessageSquareText size={15} />;
  return <Activity size={15} />;
}

function Timeline({ events, sessionId }: { events: TimelineEvent[]; sessionId: string }) {
  if (events.length === 0) return <div className="timeline-empty"><Clock3 size={19} />{t("发送消息后，Codex 的回复和操作进度会显示在这里。")}</div>;
  return (
    <div className="timeline">
      {events.map((event) => (
        <article className={`timeline-event timeline-event--${event.actor ?? "system"}`} key={event.id} data-scroll-anchor={event.id}>
          <span className="timeline-event__node"><EventIcon event={event} /></span>
          <div className="timeline-event__head">
            <strong>{systemText(event.title) || (event.actor === "user" ? t("你") : event.actor === "agent" ? "Codex" : event.type)}{event.type === "turn.completed" && <span className="timeline-event__turn-tokens"> · {event.turnTokens == null ? t("本轮 token 未记录") : t("本轮消耗 {0} tokens", new Intl.NumberFormat(locale()).format(event.turnTokens))} · {event.turnCacheHitRate == null ? t("缓存命中率未记录") : t("缓存命中率 {0}%", new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(event.turnCacheHitRate))}</span>}</strong>
            <time>{new Date(event.occurredAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</time>
          </div>
          {event.payloadState === "deleted" ? <p className="deleted-copy">{t("正文已按保留策略删除")}</p> : event.body ? event.actor === "agent" ? <MarkdownMessage body={event.body} sessionId={sessionId} /> : <p>{event.body}</p> : null}
          {event.payloadState !== "deleted" && Boolean(event.images?.length) && <MessageImages images={event.images!} />}
          {event.payloadState !== "deleted" && <CommandExecution command={event.command} output={event.output} />}
          {event.diff && <div className="diff-summary"><FileDiff size={14} />{count(event.diff.files, "个文件")} <b>+{event.diff.additions}</b> <i>−{event.diff.deletions}</i></div>}
        </article>
      ))}
    </div>
  );
}

function ApprovalCard({ approval, onDecide, busy }: { approval: Approval; onDecide: (decision: "accept" | "decline") => void; busy: boolean }) {
  return (
    <section className={`approval-card approval-card--${approval.risk}`}>
      <div className="approval-card__head">
        <span className="approval-icon"><KeyRound size={18} /></span>
        <div><div className="eyebrow">{t("Codex 需要你确认")}</div><h3>{approval.summary}</h3></div>
        <span className={`risk-label risk-label--${approval.risk}`}>{approval.risk === "high" ? t("高风险") : approval.risk === "medium" ? t("需确认") : t("低风险")}</span>
      </div>
      <dl className="approval-context">
        <div><dt>{t("主机 / 项目")}</dt><dd>{approval.machineName} / {approval.projectAlias}</dd></div>
        <div><dt>{t("工作目录")}</dt><dd title={approval.cwd}>{approval.cwd}</dd></div>
        <div><dt>{t("操作范围")}</dt><dd>{approval.grantScope === "turn" ? t("授权持续到本轮任务结束") : t("本次请求所列操作")}{locale() === "en" ? " " : ""}{t("，不更改主机默认权限")}</dd></div>
        {approval.networkTarget && <div><dt>{t("联网目标")}</dt><dd>{approval.networkTarget}</dd></div>}
        {!!approval.paths?.length && <div><dt>{t("访问路径")}</dt><dd>{approval.paths.join("、")}</dd></div>}
      </dl>
      {approval.command && <pre className="command-block"><span>$</span> {approval.command}</pre>}
      {approval.additionalPermissions && <pre className="command-block">{approval.additionalPermissions}</pre>}
      <div className="approval-actions">
        <button className="button button--danger-quiet" type="button" disabled={busy} onClick={() => onDecide("decline")}><X size={16} />{t("拒绝")}</button>
        <button className="button button--primary" type="button" disabled={busy} onClick={() => onDecide("accept")}><Check size={16} />{approval.grantScope === "turn" ? t("仅本轮允许") : t("仅本次允许")}</button>
      </div>
      <p className="approval-foot">{t("只允许本次请求，不会保存长期放行规则。需要持续联网或部署，可在主机、项目或会话的执行权限中配置。")}</p>
    </section>
  );
}

type TurnAdditions = {
  attachments?: Array<{ name: string; relativePath: string; mimeType: string; data: string }>;
  plugins?: Array<{ pluginId: string; pluginName: string }>;
  goal?: string;
};

export function SessionInspector({ detail, loading, draftOwner, onLoadHistory, historyLoading, onRefresh, onClaim, onReleaseManagement,  onSend, onQueue, onSteer, onCancelQueued, onCancel, onApproval, onClose, onNewSession }: {
  detail?: SessionDetail;
  loading: boolean;
  draftOwner?: string;
  onLoadHistory?: () => void;
  historyLoading?: boolean;
  onRefresh: () => void;
  onClaim: () => Promise<void>;
  onContinueManaged: () => Promise<void>;
  onReleaseManagement: () => Promise<void>;
  onSend: (prompt: string, settings?: CodexSettings, images?: string[], additions?: TurnAdditions) => Promise<void>;
  onQueue: (prompt: string, settings?: CodexSettings, images?: string[], additions?: TurnAdditions) => Promise<void>;
  onSteer: (prompt: string, images?: string[], additions?: TurnAdditions) => Promise<void>;
  onCancelQueued: (queueItemId: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onApproval: (decision: "accept" | "decline") => Promise<void>;
  onClose?: () => void;
  onNewSession?: () => void;
}) {
  const [prompt, setPrompt] = useSessionDraft(draftOwner ?? "preview", detail?.session.id);
  const writingSettings = useCompletionPreferences(draftOwner ?? "preview", detail?.session.id);
  const [completionPreferences] = writingSettings;
  const writingMemory = useWritingMemory(draftOwner ?? "preview", detail?.session.id, detail?.events.at(-1)?.id);
  const [aiResult, setAIResult] = useState<{session:string;draft:string;suggestions:string[]}>();
  const [aiBusy, setAIBusy] = useState(false);
  const [aiMessage, setAIMessage] = useState("");
  const aiRequest = useRef<AbortController | null>(null);
  useEffect(() => { aiRequest.current?.abort(); setAIBusy(false); setAIResult(undefined); setAIMessage(""); }, [prompt, draftOwner, detail?.session.id, completionPreferences.suggestions]);
  useEffect(() => () => aiRequest.current?.abort(), []);
  const imageDraft = useImageDraft(draftOwner ?? "preview", detail?.session.id);
  const fileDraft = useFileDraft(detail?.session.id);
  const [selectedPlugins, setSelectedPlugins] = useState<Array<{ pluginId: string; pluginName: string }>>([]);
  const [goal, setGoal] = useSessionDraft(draftOwner ?? "preview", detail?.session.id, "goal");
  const [modeOverride, setModeOverride] = useState<"default" | "plan">();
  const [configuration, setConfiguration] = useState<ConfigurationRequest>();
  const [runtimeChoice, setRuntimeChoice] = useState<RuntimeChoice>();
  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeSummary>();
  const [commandMessage, setCommandMessage] = useState("");
  const [rawView, setRawView] = useState(false);
  const [nativeRequest, setNativeRequest] = useState<{ sessionId: string; action: NativeOperation; args: string; nonce: number }>();
  const [inspectionRequest, setInspectionRequest] = useState<{ sessionId: string; section: string; nonce: number }>();
  const settings = runtimeChoice?.sessionId === detail?.session.id ? runtimeChoice?.settings : undefined;
  const [busy, setBusy] = useState(false);
  const [releaseConfirming, setReleaseConfirming] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDetailsElement>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [completionCaret, setCompletionCaret] = useState(0);
  const [activeCompletion, setActiveCompletion] = useState(0);
  const [dismissedCompletion, setDismissedCompletion] = useState("");
  const [completionFocused, setCompletionFocused] = useState(false);
  const [composingPrompt, setComposingPrompt] = useState(false);
  const [completionSelectionEnd, setCompletionSelectionEnd] = useState(0);
  const completionKey = `${prompt}\u0000${completionCaret}`;
  const completionVisible = !loading && !busy && completionFocused && !composingPrompt && completionSelectionEnd === completionCaret && dismissedCompletion !== completionKey;
  const chineseSuggestions = useChineseNLP(draftOwner ?? "preview", detail?.session.id, prompt, completionVisible && completionCaret === prompt.length && completionPreferences.suggestions && completionPreferences.nlp);
  const completions = useMemo(() => {
    if (!completionVisible) return [];
    const plugins = pluginCompletions(prompt, completionCaret, detail?.session.plugins, selectedPlugins);
    if (plugins) return plugins;
    return mergeWritingSuggestions(promptCompletions(prompt, completionCaret, 10, writingMemory.value?.entries).filter(item => item.kind === "term" ? completionPreferences.terms : completionPreferences.suggestions), chineseSuggestions);
  }, [completionVisible, completionCaret, prompt, completionPreferences.terms, completionPreferences.suggestions, writingMemory.value, chineseSuggestions, detail?.session.plugins, selectedPlugins]);
  useAutoSizeTextarea(textArea, prompt, `${detail?.session.id ?? ""}:${loading}`);
  useEffect(() => { setConfiguration(undefined); setReleaseConfirming(false); setRawView(false); setCommandMessage(""); setSelectedPlugins([]); setModeOverride(undefined); }, [detail?.session.id, draftOwner]);
  useEffect(() => { setActiveCompletion(0); }, [completionKey, completionPreferences.terms, completionPreferences.suggestions]);
  useEffect(() => { setActiveCompletion(current => Math.min(current, Math.max(0, completions.length - 1))); }, [completions.length]);
  useEffect(() => { setCompletionFocused(false); setComposingPrompt(false); setCompletionCaret(0); setCompletionSelectionEnd(0); }, [detail?.session.id, draftOwner, loading]);
  useEffect(() => {
    if (!addMenuOpen) return;
    const dismissOutside = (event: PointerEvent) => { if (!addMenu.current?.contains(event.target as Node)) setAddMenuOpen(false); };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAddMenuOpen(false);
      addMenu.current?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => { document.removeEventListener("pointerdown", dismissOutside); document.removeEventListener("keydown", dismissWithKeyboard); };
  }, [addMenuOpen]);

  function acceptCompletion(completion: PromptCompletion) {
    if (completion.memoryId && detail) void api.acceptWritingEntry(detail.session.id, completion.memoryId).catch(() => undefined);
    if (completion.plugin) setSelectedPlugins(current => current.some(item => item.pluginId === completion.plugin!.pluginId) ? current : [...current, completion.plugin!]);
    const next = applyPromptCompletion(prompt, completion);
    setPrompt(next.value);
    setCompletionCaret(next.caret);
    setCompletionSelectionEnd(next.caret);
    setDismissedCompletion(`${next.value}\u0000${next.caret}`);
    requestAnimationFrame(() => {
      const input = textArea.current;
      if (input?.value === next.value) {
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
      }
    });
  }

  if (loading) return <aside className="inspector inspector--loading"><IconButton label={t("关闭会话详情")} className="inspector-back" onClick={onClose}><ChevronLeft size={22} /></IconButton><LoaderCircle className="spin" size={22} /><span>{t("正在读取会话")}</span></aside>;
  if (!detail) return <aside className="inspector inspector--empty"><MonitorDot size={27} /><h2>{t("选择一个会话")}</h2><p>{t("打开已有会话，或新建会话开始。")}</p></aside>;

  const { session, approval } = detail;
  const rawEvents = rawView ? detail.events.filter(event => event.payloadState !== "deleted" && event.body) : [];
  const visibleEvents = timelineItems(detail.events);
  const lease = session.controlLease;
  const managed = session.state.ownership === "agentfleet_owned";
  const pendingCommand = (detail.commands ?? []).some(commandPending);
  const canClaim = !pendingCommand && (session.actions?.claim?.allowed ?? (session.state.ownership === "claimable" && session.state.threadRuntime === "idle" && session.state.reachability === "live" && !session.state.unknownFreeze));
  const queueBusy = detail.queue.some((item) => item.state === "queued" || item.state === "dispatching" || item.state === "unknown");
  const canReleaseManagement = !pendingCommand && (session.actions?.release?.allowed ?? Boolean(detail.releaseManagementSupported && session.nativeThreadId && detail.writable && (!lease || lease.isMine) && session.state.threadRuntime === "idle" && !session.activeTurnId && approval?.status !== "pending" && !queueBusy && !session.state.unknownFreeze));
  const canSend = !pendingCommand && (session.actions?.start?.allowed ?? Boolean(detail.writable && (!lease || lease.isMine) && session.state.threadRuntime === "idle" && !session.state.unknownFreeze));
  const canCancel = !pendingCommand && (session.actions?.cancel?.allowed ?? Boolean(detail.writable && (!lease || lease.isMine) && session.state.currentTurn === "in_progress" && session.activeTurnId));
  const canQueueOrSteer = Boolean(detail.writable && session.state.currentTurn === "in_progress" && session.activeTurnId);
  const slashCommand = parseCodexCommand(prompt);
  const additions: TurnAdditions | undefined = fileDraft.files.length || selectedPlugins.length || goal.trim() ? { ...(fileDraft.files.length ? { attachments: fileDraft.files.map(({ name, relativePath, mimeType, data }) => ({ name, relativePath, mimeType, data })) } : {}), ...(selectedPlugins.length ? { plugins: selectedPlugins } : {}), ...(goal.trim() ? { goal: goal.trim() } : {}) } : undefined;
  const hasInput = Boolean(prompt.trim() || imageDraft.images.length || fileDraft.files.length || selectedPlugins.length);
  const imageBlocked = imageDraft.processing || fileDraft.processing || (imageDraft.images.length > 0 && (!session.imageInputSupported || Boolean(slashCommand))) || (fileDraft.files.length > 0 && (!session.fileInputSupported || Boolean(slashCommand)));
  const inherited = session.runtimeSettings?.accepted ?? session.runtimeSettings?.observed;
  const sendSettings = modeOverride && inherited?.model ? { model: inherited.model, ...(inherited.effort ? { effort: inherited.effort } : {}), ...(settings ?? {}), mode: modeOverride } satisfies CodexSettings : settings;
  async function runSlash(name: string, args = "") {
    setCommandMessage("");
    const command = codexCommands.find((item) => item.name === name);
    if (!command) { setCommandMessage(t("/{0} 未识别，未向宿主机发送。", name)); return; }
    if (command.action === "pending" || command.action === "terminal") { setCommandMessage(t("/{0} · {1}：{2} 未向宿主机发送。", name, coverageLabels[command.coverage], command.note)); return; }
    name = command.canonical ?? name;
    if (["native", "inspect", "help"].includes(command.action)) {
      setConfiguration({ section: command.action === "help" ? "help" : "tools", nonce: Date.now() });
    }
    if (args.trim() && ["inspect", "copy", "diff", "close", "help", "new"].includes(command.action)) { setCommandMessage(t("/{0} 当前只支持不带参数的面板入口。{1} 未发送附加参数。", name, command.note)); return; }
    if (command.action === "help") {
      setPrompt(""); return;
    } else if (command.action === "draft") { setPrompt(`${t(initInstructions)}${args.trim() ? t("\n补充要求：{0}", args.trim()) : ""}`); setCommandMessage(t("项目指令任务已填入草稿；检查后点击发送才会执行，可能消耗模型额度。")); return;
    } else if (command.action === "raw") {
      if (args.trim() && !["on", "off"].includes(args.trim())) { setCommandMessage(t("用法：/raw、/raw on 或 /raw off。")); return; }
      setRawView(args.trim() === "on" ? true : args.trim() === "off" ? false : !rawView); setPrompt(""); return;
    }
    if (command.action === "permissions") {
      if (args.trim()) { setCommandMessage(t("/permissions 不带参数；请在执行权限中选择并保存配置。")); return; }
      setConfiguration({ section: "permissions", nonce: Date.now() });
      setCommandMessage(t("执行权限已展开。保存后，新提交的任务采用最新继承配置。"));
    } else if (command.action === "settings") {
      setConfiguration({ section: "settings", nonce: Date.now() });
      setCommandMessage(name === "plan" ? t("请在运行配置中选择计划模式；选择后，下一次发送时应用。") : t("运行配置已展开。模型未上报时不会猜测默认值。"));
    } else if (command.action === "copy") {
      const body = detail?.events.slice().reverse().find((event) => event.actor === "agent" && event.body && event.payloadState !== "deleted")?.body;
      if (!body) { setCommandMessage(t("当前已加载历史中没有可复制的回复。")); return; }
      try { await navigator.clipboard.writeText(body); setCommandMessage(t("已复制最后一条已同步回复。")); }
      catch { setCommandMessage(t("浏览器未允许复制，请手动选择回复内容。")); return; }
    } else if (command.action === "diff") {
      const diff = textArea.current?.closest(".inspector")?.querySelector<HTMLElement>(".diff-summary");
      if (!diff) { setCommandMessage(t("当前已加载历史中没有代码差异；这不代表项目没有未提交修改。")); return; }
      diff.scrollIntoView({ block: "center" }); setCommandMessage(t("已定位到已同步的差异摘要。"));
    } else if (command.action === "new") {
      if (!onNewSession) { setCommandMessage(t("请使用项目列表的新会话按钮。")); return; }
      onNewSession();
    } else if (command.action === "inspect") {
      setInspectionRequest({ sessionId: session.id, section: name === "debug-config" ? "config" : name === "ps" ? "terminals" : name, nonce: Date.now() });
      setPrompt(""); return;
    } else if (command.action === "native") {
      if (args.trim() && name !== "rename") { setCommandMessage(t("/{0} 当前不支持附加参数，请在操作区确认；未向宿主机发送。", name)); return; }
      setNativeRequest({ sessionId: session.id, action: name as NativeOperation, args, nonce: Date.now() });
      setPrompt(""); return;
    } else if (command.action === "close") onClose?.();
    setPrompt(args);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (imageBlocked || busy) return;
    if (prompt.trim() === "/") return;
    if (slashCommand) { await runSlash(slashCommand.name, slashCommand.args); return; }
    if (!hasInput || !canSend) return;
    setBusy(true);
    try {
      if (additions) await onSend(prompt.trim(), sendSettings, imageDraft.images.length ? imageDraft.images : undefined, additions);
      else await onSend(prompt.trim(), sendSettings, imageDraft.images.length ? imageDraft.images : undefined);
      setCommandMessage("");
      setPrompt("");
      imageDraft.clear();
      fileDraft.clear(); setSelectedPlugins([]);
      setModeOverride(undefined);
      textArea.current?.focus();
    } catch (error) {
      setCommandMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const aiOptimizeButton = completionPreferences.suggestions && <button type="button" className="button button--secondary composer-ai-button" title={t("保留原意，让描述更清晰、专业")} disabled={aiBusy || busy || !prompt.trim() || Boolean(slashCommand)} onClick={async()=>{
            const controller = new AbortController(); aiRequest.current?.abort(); aiRequest.current=controller; setAIBusy(true); setAIMessage("");
            try {
              const settings = await api.writingAI();
              if (controller.signal.aborted) return;
              if (!settings.enabled || !settings.configured) { setAIMessage(t("请先在设置中配置 AI 理解；基础补全与自动学习仍可使用")); return; }
              const result = await api.writingSuggestions(session.id,prompt,controller.signal);
              if (!controller.signal.aborted) { setAIResult({session:session.id,draft:prompt,suggestions:result.suggestions}); if(!result.suggestions.length)setAIMessage(t("暂无更合适的表达，保留当前草稿")); }
            } catch (error) { if(!controller.signal.aborted)setAIMessage(writingAIErrorMessage(error)); }
            finally { if(!controller.signal.aborted)setAIBusy(false); }
          }}>{aiBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{aiBusy ? t("正在优化…") : t("优化表达")}</button>;

  return (
    <aside className="inspector">
      <header className="inspector-head">
        <IconButton label={t("关闭会话详情")} className="inspector-back" onClick={onClose}><ChevronLeft size={22} /></IconButton>
        <div className="eyebrow inspector-context" title={`${session.machineName} · ${session.projectAlias}`}>{session.machineName} · {session.projectAlias}</div>
        <div className="inspector-title-row">
          <h2 title={session.title}>{session.title}</h2>
          <div className="session-facts">
            <StatePill session={session} />
            <span className={`history-mark history-mark--${session.state.history}`}>{{ complete: t("完整历史"), partial: t("部分历史"), summary_only: t("历史摘要"), metadata_only: t("仅会话信息"), unavailable: t("历史暂不可用") }[session.state.history]}</span>
            <UsageButton scope="session" id={session.id}/>
          </div>
        <div className="inspector-head__actions">
          <button type="button" className="button button--quiet session-config-trigger" aria-haspopup="dialog" aria-label={t("会话配置")} title={t("会话配置")} onClick={() => setConfiguration({ section: "all", nonce: Date.now() })}><Settings2 size={18} /><span>{t("会话配置")}</span></button>
          <SessionActions>
            <button type="button" className="button button--quiet" onClick={onRefresh}><RefreshCw size={16} />{t("刷新会话")}</button>
            <NativeSessionDeletion key={`delete:${draftOwner}:${session.id}`} session={session} commands={detail.commands ?? []} pending={pendingCommand} onChanged={onRefresh} />
          </SessionActions>
        </div>
        </div>
      </header>
      {managed ? (
        <div className={`lease-strip${lease?.isMine ? " lease-strip--mine" : ""}${(!lease || lease.isMine) && detail.releaseManagementSupported && !releaseConfirming ? " lease-strip--ready" : ""}`}>
          <span className="lease-strip__icon"><UserRoundCheck size={16} /></span>
          <div>
            <strong>{lease && !lease.isMine ? t("其他账号正在操作") : t("可从面板继续会话")}</strong>
            <span>{!detail.releaseManagementSupported ? detail.releaseManagementBlockedReason : releaseConfirming ? t("等待主机释放面板写入占用；主机会话、本地和云端历史都会保留。有后台任务时不会强制交接") : lease && !lease.isMine ? t("等待对方操作结束后继续") : t("可在其他设备继续，执行中的任务保持运行。")}</span>
          </div>
          <div className="lease-strip__actions">
            {detail.releaseManagementSupported && (releaseConfirming ? (
              <>
                <button type="button" disabled={busy} onClick={() => setReleaseConfirming(false)}>{t("保留接管")}</button>
                <button className="release-management" type="button" disabled={!canReleaseManagement || busy} onClick={async () => { setBusy(true); try { await onReleaseManagement(); setReleaseConfirming(false); } finally { setBusy(false); } }}>{busy ? <LoaderCircle className="spin" size={14} /> : <Unplug size={14} />}{locale() === "en" ? " " : ""}{t("确认取消")}</button>
              </>
            ) : (
              <button className="release-management" type="button" title={!canReleaseManagement ? detail.releaseManagementBlockedReason ?? t("请先等待当前操作结束") : t("退出面板接管，保留两端会话与历史")} disabled={!canReleaseManagement || busy} onClick={() => setReleaseConfirming(true)}><Unplug size={14} />{t("取消接管")}</button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`share-strip${canClaim ? " share-strip--ready" : ""}`}>
          <span className="share-strip__icon"><Share2 size={16} /></span>
          <div>
            <strong>{session.historyMode !== "unknown" ? t("宿主机共享会话") : t("仅可查看的宿主机会话")}</strong>
            <span>{canClaim ? t("同步主机上的历史，继续原来的 Codex 会话") : systemText(session.actions?.claim?.message) || (session.state.threadRuntime === "active" ? t("请先结束宿主机正在运行的任务") : t("正在检查这个会话是否支持继续操作"))}</span>
          </div>
            <button className="button button--share" type="button" disabled={!canClaim || busy} onClick={async () => { setBusy(true); try { await onClaim(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle className="spin" size={15} /> : <Share2 size={15} />}{locale() === "en" ? " " : ""}{t("接管并同步")}</button>
        </div>
      )}
      {session.state.unknownFreeze && <div className="freeze-banner"><AlertTriangle size={17} /><div><strong>{t("结果不确定，写入已冻结")}</strong><span>{t("可以点击解除冻结核验主机结果；系统不会自动重发原命令。")}</span><SessionRecovery key={`${draftOwner}:${session.id}`} machineId={session.machineId} sessionId={session.id} online={detail.hostOnline === true} supported={detail.recoverySupported === true} onChanged={onRefresh} /></div></div>}
      <ConversationViewport key={`${draftOwner}:${session.id}`} events={rawView ? detail.events : visibleEvents}>{detail.historyPage?.nextBeforeSeq != null && <button className="catalog-more" type="button" disabled={historyLoading} onClick={onLoadHistory}>{historyLoading ? t("正在读取更早记录…") : t("加载更早记录")}</button>}{rawView ? <pre className="codex-raw-view" aria-label={t("已同步内容纯文本")}>{rawEvents.length ? rawEvents.map(event => <span key={event.id} data-scroll-anchor={event.id}>{event.actor}{"\n"}{event.body}{"\n\n"}</span>) : t("尚无已同步正文")}</pre> : <Timeline events={visibleEvents} sessionId={session.id} />}</ConversationViewport>
      {approval?.status === "pending" && (approval.type === "user_input"
        ? <CodexInputCard key={`${draftOwner}:${approval.id}`} request={approval} onChanged={onRefresh} />
        : <ApprovalCard approval={approval} busy={busy} onDecide={async (decision) => { setBusy(true); try { await onApproval(decision); } finally { setBusy(false); } }} />)}
      <OperationReceipts commands={detail.commands ?? []} mode="outstanding" />
      {(detail.session.state.unknownFreeze || (detail.commands ?? []).some(command => command.state === "unknown")) && <CommandRecovery key={`recovery:${draftOwner}:${session.machineId}`} machineId={session.machineId} online={session.state.reachability === "live"} supported={detail.commandRecoverySupported === true} onChanged={onRefresh} />}
      {detail.queue.some((item) => item.state === "queued" || item.state === "dispatching" || item.state === "unknown") && (
        <section className="turn-queue" aria-label={t("待执行队列")}>
          <div className="turn-queue__head"><strong>{t("待执行队列")}</strong><span>{t("按控制面接受顺序")}</span></div>
          {detail.queue.filter((item) => item.state === "queued" || item.state === "dispatching" || item.state === "unknown").map((item, index) => (
            <div className="turn-queue__item" key={item.id}>
              <span className="turn-queue__position">{index + 1}</span>
              <div><strong>{item.state === "unknown" ? t("结果待核验，不会自动重发") : item.state === "dispatching" ? (item.waitingForHost ? t("等待主机同步后派发") : t("正在派发")) : item.prompt}</strong><span>{item.mine ? t("当前浏览器") : t("其他浏览器")} · {t("{0} 前有效", new Date(item.expiresAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }))}</span></div>
              {item.state === "queued" && <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onCancelQueued(item.id); } finally { setBusy(false); } }}>{t("取消")}</button>}
            </div>
          ))}
        </section>
      )}
      <SessionConfiguration key={`config:${draftOwner}:${session.id}`} request={configuration} title={session.title} onClose={() => setConfiguration(undefined)}>
        {configuration && commandMessage && <p className="codex-command-message" role="status">{systemText(commandMessage)}</p>}
        <OperationReceipts commands={detail.commands ?? []} mode="recent" />
        <CodexSettingsPanel key={`${draftOwner}:${session.id}`} sessionId={session.id} observed={session.runtimeSettings} onChange={setRuntimeChoice} onSummary={setRuntimeSummary} />
        <PermissionPanel key={`permissions:${session.id}`} sessionId={session.id} observed={session.runtimeSettings} />
        <SessionWritingPreferencesPanel key={`writing:${draftOwner}:${session.id}`} settings={writingSettings} />
        <details className="composer-tools session-config-section" key={`tools:${draftOwner}:${session.id}`}><summary><span>{t("更多工具与命令")}<small>{t("原生会话操作、环境查询与命令说明")}</small></span></summary><p>{t("重命名、归档、环境查询和 / 命令。日常对话直接在下方发送消息即可。")}</p>
          <NativeSessionActions key={`native:${draftOwner}:${session.id}`} session={session} request={nativeRequest?.sessionId === session.id ? nativeRequest : undefined} pending={pendingCommand} onChanged={onRefresh} />
          <CodexInspectionPanel key={`inspect:${draftOwner}:${session.id}`} session={session} commands={detail.commands ?? []} request={inspectionRequest?.sessionId === session.id ? inspectionRequest : undefined} onChanged={onRefresh} />
          <CodexCommandGuide key={`commands:${draftOwner}:${session.id}`} />
        </details>
        <details className="session-sync-details session-config-section"><summary><span>{t("同步详情")}<small>{t("查看会话同步状态的排查信息")}</small></span></summary><p className="mono">seq {session.sessionSeq} · epoch {session.contentEpoch}</p></details>
      </SessionConfiguration>
      <form className="composer" onSubmit={submit}>
        {prompt.trimStart().startsWith("/") && <div className="codex-command-menu" role="group" aria-label={t("Codex 命令")}><p>{t("面板命令 · 点击待接入项可查看原因，不会发送给模型")}</p>{codexCommands.filter((item) => item.name.includes(prompt.trim().slice(1).split(/\s/)[0].toLowerCase())).map((item) => <button type="button" key={item.name} onClick={() => void runSlash(item.name, slashCommand?.args)}><code>/{item.name}</code><span>{item.label} · {coverageLabels[item.coverage]}</span></button>)}</div>}
        {!configuration && commandMessage && <p className="codex-command-message" role="status">{systemText(commandMessage)}</p>}
        {(!managed || (lease && !lease.isMine && !canQueueOrSteer)) && <div className="composer-lock"><LockKeyhole size={14} />{!managed ? systemText(detail.writeBlockedReason) : t("其他窗口正在控制，草稿会保存在当前会话")}</div>}
        {canQueueOrSteer && <div className="composer-mode"><Activity size={14} />{t("Codex 正在处理：可补充当前任务，或排到下一轮")}</div>}
        <RuntimeSettingsShortcut sessionId={session.id} summary={runtimeSummary} observed={session.runtimeSettings} running={session.state.currentTurn === "in_progress" && Boolean(session.activeTurnId)} activeTurnId={session.activeTurnId} modeOverride={modeOverride === "plan" ? "plan" : undefined} goal={goal.trim() || undefined} onClearGoal={() => setGoal("")} onClearMode={() => setModeOverride(undefined)} onOpen={() => setConfiguration({ section: "settings", nonce: Date.now() })}/>
        <div className="composer-input">
        {aiMessage && <p className="image-draft-notice" role="status">{aiMessage}</p>}
        {aiResult?.session === session.id && aiResult.draft === prompt && <div className="writing-ai-results prompt-completions" role="group" aria-label={t("AI 表达建议")}>{aiResult.suggestions.map(suggestion=><button type="button" data-kind="rewrite" key={suggestion} onMouseDown={event=>event.preventDefault()} onClick={()=>{setPrompt(suggestion);setAIResult(undefined);textArea.current?.focus();}}><span className="prompt-completion__kind">{t("表达优化")} · AI</span><code>{suggestion}</code><small>{t("点击采用")}</small></button>)}</div>}
        {imageDraft.images.length > 0 && <MessageImages images={imageDraft.images} onRemove={imageDraft.remove} disabled={busy || imageDraft.processing} />}
        {(fileDraft.files.length > 0 || selectedPlugins.length > 0) && <div className="attachment-drafts" aria-label={t("待发送附件")}>
          {fileDraft.files.map(file => <span className="attachment-chip" key={file.id}><Paperclip size={14} /><span title={file.relativePath}>{file.relativePath}</span><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small><button type="button" aria-label={t("移除 {0}", file.relativePath)} onClick={() => fileDraft.remove(file.id)}><X size={13} /></button></span>)}
          {selectedPlugins.map(plugin => <span className="attachment-chip attachment-chip--plugin" key={plugin.pluginId}><Puzzle size={14} /><span>{plugin.pluginName}</span><button type="button" aria-label={t("移除 {0}", plugin.pluginName)} onClick={() => setSelectedPlugins(current => current.filter(item => item.pluginId !== plugin.pluginId))}><X size={13} /></button></span>)}
        </div>}
        {imageDraft.processing && <p className="image-draft-notice" role="status">{t("正在处理图片…")}</p>}
        {fileDraft.processing && <p className="image-draft-notice" role="status">{t("正在读取文件…")}</p>}
        {imageDraft.error && <p className="image-draft-notice" role="alert">{systemText(imageDraft.error)}</p>}
        {fileDraft.error && <p className="image-draft-notice" role="alert">{systemText(fileDraft.error)}</p>}
        {imageDraft.images.length > 0 && <p className="image-draft-notice">{!session.imageInputSupported ? t("请先在主机页更新连接服务，才能发送图片") : slashCommand ? t("图片请搭配普通消息发送，不与 / 命令一起执行") : t("图片已处理为发送尺寸 · 可点击预览 · 最多 4 张")}</p>}
        {completions.length > 0 && <CompletionSurface anchor={textArea}><div className={`prompt-completions-shell${completions.some(item => item.kind === "rewrite") ? " prompt-completions-shell--rewrite" : ""}`}><div className="prompt-completions" role="listbox" id="prompt-completions" aria-label={completions[0]?.kind === "plugin" ? t("插件") : t("编程提示语补全")}>
          <div className="prompt-completions__head" role="presentation">{completions[0]?.kind === "plugin" ? <Puzzle size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}<span>{completions[0]?.kind === "plugin" ? t("插件") : t("输入建议")}</span><kbd>Tab</kbd><span className="prompt-completions__touch">{t("点击采用")}</span></div>
          {completions.map((completion, index) => <button
            type="button"
            role="option"
            data-kind={completion.kind}
            aria-selected={index === activeCompletion}
            id={`prompt-completion-${index}`}
            className={index === activeCompletion ? "prompt-completion--active" : ""}
            key={`${completion.kind}:${completion.label}`}
            tabIndex={-1}
            title={completion.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => acceptCompletion(completion)}
            onMouseEnter={() => setActiveCompletion(index)}
          ><span className="prompt-completion__kind">{completion.kind === "plugin" ? t("插件") : completion.kind === "term" ? t("术语") : completion.kind === "rewrite" ? t("表达优化") : t("提示语")}</span><code>{completion.label}</code><small>{t(completion.detail)}</small></button>)}
        </div><button type="button" className="prompt-completions-dismiss" aria-label={t("收起补全建议")} title={t("收起补全建议")} onMouseDown={event => event.preventDefault()} onClick={() => { setDismissedCompletion(completionKey); textArea.current?.focus(); }}><X size={16} aria-hidden="true" /></button></div></CompletionSurface>}
        <textarea
          ref={textArea}
          aria-label={t("发送给 Codex 的消息")}
          aria-autocomplete="list"
          aria-controls={completions.length > 0 ? "prompt-completions" : undefined}
          aria-activedescendant={completions.length > 0 ? `prompt-completion-${activeCompletion}` : undefined}
          placeholder={canSend ? t("告诉 Codex 下一步做什么…") : canQueueOrSteer ? t("补充当前任务，或写入下一轮队列…") : t("先写下想法，恢复可用后手动发送…")}
          value={prompt}
          onChange={(event) => { setPrompt(event.target.value); setCompletionFocused(true); setCompletionCaret(event.target.selectionStart); setCompletionSelectionEnd(event.target.selectionEnd); setDismissedCompletion(""); }}
          onFocus={() => setCompletionFocused(true)}
          onBlur={() => { if (!window.matchMedia?.("(max-width: 900px), (pointer: coarse)").matches) setCompletionFocused(false); }}
          onCompositionStart={() => setComposingPrompt(true)}
          onCompositionEnd={(event) => { setComposingPrompt(false); setCompletionCaret(event.currentTarget.selectionStart); setCompletionSelectionEnd(event.currentTarget.selectionEnd); }}
          onSelect={(event) => { setCompletionCaret(event.currentTarget.selectionStart); setCompletionSelectionEnd(event.currentTarget.selectionEnd); }}
          onPaste={event => { if (!busy) void imageDraft.onPaste(event); }}
          disabled={busy}
          rows={1}
          onKeyDown={(event) => {
            if (composingPrompt || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (completions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveCompletion((current) => (current + (event.key === "ArrowDown" ? 1 : completions.length - 1)) % completions.length);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedCompletion(completionKey);
                return;
              }
              if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
                event.preventDefault();
                acceptCompletion(completions[activeCompletion] ?? completions[0]);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && (completions[activeCompletion] ?? completions[0])?.kind === "plugin") {
                event.preventDefault();
                acceptCompletion(completions[activeCompletion] ?? completions[0]);
                return;
              }
            }
            if (event.key !== "Enter") return;
            // On a touch keyboard Return inserts a line; the visible Send button submits.
            if (window.matchMedia?.("(max-width: 900px), (pointer: coarse)").matches && !event.ctrlKey && !event.metaKey) return;
            if ((event.ctrlKey || event.metaKey) && !event.altKey) {
              event.preventDefault();
              const input = event.currentTarget;
              const caret = input.selectionStart + 1;
              const nextPrompt = input.value.slice(0, input.selectionStart) + "\n" + input.value.slice(input.selectionEnd);
              setPrompt(nextPrompt);
              requestAnimationFrame(() => {
                if (textArea.current === input && input.value === nextPrompt) input.setSelectionRange(caret, caret);
              });
            } else if (!event.shiftKey && !event.altKey && !event.metaKey && canSend) {
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-actions">
          <span className="composer-keyboard-hint" title={detail.writeBlockedReason || t("可直接粘贴截图，最多 4 张；Tab 补全，Enter 发送，Ctrl / ⌘ + Enter 换行")}>{detail.writeBlockedReason || (canSend ? t("Tab 补全 · Enter 发送 · Ctrl / ⌘ + Enter 换行") : t("请先检查会话连接与执行状态"))}</span>
          <span className="composer-touch-hint">{detail.writeBlockedReason || (canSend || canQueueOrSteer ? t("回车换行") : t("请先检查会话连接与执行状态"))}</span>
          <div className="composer-button-group">
          <input ref={imageInput} className="composer-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label={t("选择要发送的图片")} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void imageDraft.addFiles(files); }} />
          <input ref={fileInput} className="composer-image-input" type="file" accept={ATTACHMENT_ACCEPT} multiple aria-label={t("选择要发送的文件")} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void fileDraft.add(files); }} />
          <input ref={(node) => { folderInput.current = node; if (node) { node.setAttribute("webkitdirectory", ""); node.setAttribute("accept", ATTACHMENT_ACCEPT); } }} className="composer-image-input" type="file" multiple aria-label={t("选择要发送的文件夹")} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void fileDraft.add(files); }} />
          <details ref={addMenu} open={addMenuOpen} onToggle={event => setAddMenuOpen(event.currentTarget.open)} className="composer-add-menu"><summary className="button button--secondary composer-add-trigger" aria-label={t("添加内容")} aria-expanded={addMenuOpen} title={t("添加内容")}><Plus size={19} /></summary><div className="composer-add-popover">
            <strong>{t("添加")}</strong>
            <button type="button" disabled={busy || !session.fileInputSupported || fileDraft.processing} onClick={() => { setAddMenuOpen(false); fileInput.current?.click(); }}><FileUp size={17} /><span><b>{t("文件")}</b><small>{t("支持 .txt/.md/.json/.csv、常见源码与配置（UTF-8）")}</small></span></button>
            <button type="button" disabled={busy || !session.fileInputSupported || fileDraft.processing} onClick={() => { setAddMenuOpen(false); folderInput.current?.click(); }}><FolderOpen size={17} /><span><b>{t("文件夹")}</b><small>{t("逐个校验支持类型，最多 32 个文件")}</small></span></button>
            <button type="button" disabled={busy || imageDraft.processing || imageDraft.images.length >= 4} onClick={() => { setAddMenuOpen(false); imageInput.current?.click(); }}><ImagePlus size={17} /><span><b>{t("图片")}</b><small>{t("作为多模态图片发送")}</small></span></button>
            <label className="composer-add-field"><Target size={17} /><span><b>{t("目标")}</b><small>{t("设置要持续追求的会话目标")}</small><input value={goal} maxLength={2000} placeholder={t("输入目标…")} onChange={event => setGoal(event.target.value)} /></span></label>
            {session.collaborationModes?.includes("plan") && <button type="button" disabled={canQueueOrSteer} aria-pressed={modeOverride === "plan"} onClick={() => { if (!settings?.model && !inherited?.model) { setConfiguration({ section: "settings", nonce: Date.now() }); setCommandMessage(t("请先选择模型，再开启计划模式。")); return; } setModeOverride(current => current === "plan" ? undefined : "plan"); }}><Lightbulb size={17} /><span><b>{t("计划模式")}</b><small>{modeOverride === "plan" ? t("已开启；下一轮按计划模式运行") : !settings?.model && !inherited?.model ? t("选择模型后可开启") : t("先分析并制定计划")}</small></span><i className={modeOverride === "plan" ? "active" : ""} /></button>}
            {(session.plugins?.length ?? 0) > 0 && <><strong className="composer-add-section">{t("插件")}</strong><div className="composer-plugin-list">{session.plugins!.map(plugin => { const selected = selectedPlugins.some(item => item.pluginId === plugin.pluginId); return <button type="button" aria-pressed={selected} className={selected ? "selected" : ""} key={plugin.pluginId} onClick={() => setSelectedPlugins(current => selected ? current.filter(item => item.pluginId !== plugin.pluginId) : [...current, plugin])}><Puzzle size={17} /><span><b>{plugin.pluginName}</b></span></button>; })}</div></>}
          </div></details>
          {canQueueOrSteer ? (
            <div className="active-turn-actions">
              <div className="composer-primary-pair">{aiOptimizeButton}
              {canCancel && <button className="button button--stop" type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onCancel(); } finally { setBusy(false); } }}><Square size={14} fill="currentColor" />{t("停止任务")}</button>}
              </div><button className="button button--secondary" type="button" disabled={Boolean(slashCommand) || !hasInput || imageBlocked || busy || pendingCommand || session.actions?.queue?.allowed === false} onClick={async () => { setBusy(true); try { if (additions) await onQueue(prompt.trim(), sendSettings, imageDraft.images.length ? imageDraft.images : undefined, additions); else await onQueue(prompt.trim(), sendSettings, imageDraft.images.length ? imageDraft.images : undefined); setPrompt(""); imageDraft.clear(); fileDraft.clear(); setSelectedPlugins([]); setModeOverride(undefined); } catch (error) { setCommandMessage(errorMessage(error)); } finally { setBusy(false); } }}><Plus size={14} />{t("加入队列")}</button>
              <button className="button button--primary" type="button" disabled={Boolean(slashCommand) || !hasInput || imageBlocked || busy || pendingCommand || session.actions?.steer?.allowed === false} onClick={async () => { setBusy(true); try { if (additions) await onSteer(prompt.trim(), imageDraft.images.length ? imageDraft.images : undefined, additions); else await onSteer(prompt.trim(), imageDraft.images.length ? imageDraft.images : undefined); setPrompt(""); imageDraft.clear(); fileDraft.clear(); setSelectedPlugins([]); } catch (error) { setCommandMessage(errorMessage(error)); } finally { setBusy(false); } }}><ArrowRight size={14} />{t("追加本轮")}</button>
            </div>
          ) : <div className="composer-primary-pair">{aiOptimizeButton}{canCancel ? (
            <button className="button button--stop" type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onCancel(); } finally { setBusy(false); } }}><Square size={14} fill="currentColor" />{t("停止任务")}</button>
          ) : (
            <button className="button button--primary" disabled={!canSend || !hasInput || imageBlocked || busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{locale() === "en" ? " " : ""}{t("发送")}</button>
          )}</div>}
          </div>
        </div>
        </div>
      </form>
    </aside>
  );
}

export function ApprovalsView({ approvals, onOpen, onBack }: { approvals: Approval[]; onOpen: (id: string) => void; onBack: () => void }) {
  return (
    <section className="wide-view">
      <div className="wide-view__heading"><div><h1>{t("待处理")}</h1><p>{t("查看需要你确认的操作和回答的问题。")}</p></div><KeyRound size={31} /></div>
      <div className="request-explainer"><div><strong>{t("确认操作")}</strong><p>{t("需要你允许的命令或文件修改。你可以只允许这一次，也可以拒绝。")}</p></div><div><strong>{t("回答问题")}</strong><p>{t("Codex 需要了解你的选择或补充要求，例如计划模式中的提问。")}</p></div></div>
      {approvals.length === 0 ? <div className="wide-empty request-empty"><Check size={30} /><h2>{t("暂无待处理事项")}</h2><p>{t("有新的确认请求或问题时，会在这里提醒你。")}</p><button type="button" className="button button--primary" onClick={onBack}>{t("返回工作台")}</button></div> : (
        <div className="approval-grid">{approvals.map((approval) => <button type="button" key={approval.id} className="approval-preview" onClick={() => onOpen(approval.logicalSessionId)}><span className={`risk-stripe risk-stripe--${approval.risk}`} /><div><span className="request-kind">{approval.type === "user_input" ? t("需要回答") : t("需要确认")}</span><div className="eyebrow">{approval.machineName} · {approval.projectAlias}</div><h3>{approval.summary}</h3><p>{approval.command || approval.paths?.join(", ")}</p><span className="request-open">{t("打开会话处理 →")}</span></div><ChevronRight size={18} /></button>)}</div>
      )}
    </section>
  );
}

export function RemoveMachineDialog({ machine, onClose, onRemoved, onToast }: {
  machine?: Machine;
  onClose: () => void;
  onRemoved: () => Promise<void>;
  onToast: (tone: Toast["tone"], message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [copied, setCopied] = useState(false);
  const windows = machine?.os.toLowerCase().includes("windows") || machine?.os.toLowerCase().includes("win32");
  const macos = machine?.os.toLowerCase().includes("mac") || machine?.os.toLowerCase().includes("darwin");
  const uninstallCommand = useMemo(() => {
    if (windows) return `$i=Join-Path $env:TEMP 'agentfleet-install.ps1'; Invoke-WebRequest '${new URL("/install.ps1", location.origin).toString()}' -OutFile $i; & $i -Mode Uninstall -Purge`;
    const installer = macos ? "/install-macos" : "/install";
    return `curl -fsSL '${new URL(installer, location.origin).toString()}' | sh -s -- --uninstall --purge`;
  }, [windows, macos]);
  useEffect(() => {
    setBusy(false);
    setRemoved(false);
    setCopied(false);
  }, [machine?.id]);
  if (!machine) return null;

  async function remove() {
    setBusy(true);
    try {
      await api.removeMachine(machine!.id);
      setRemoved(true);
      await onRemoved();
      onToast("success", t("主机 {0} 已从控制面移除", machine!.name));
    } catch (error) {
      onToast("danger", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal remove-machine-modal" role="dialog" aria-modal="true" aria-labelledby="remove-machine-title">
        <div className="modal-head">
          <div><div className="eyebrow">Host removal</div><h2 id="remove-machine-title">{removed ? t("控制面已移除主机") : t("移除主机")}</h2></div>
          <button className="icon-button" aria-label={t("关闭")} title={t("关闭")} onClick={onClose} disabled={busy} type="button"><X size={18} /></button>
        </div>
        {removed ? (
          <>
            <div className="remove-machine-result"><Check size={18} /><div><strong>{machine.name} {locale() === "en" ? " " : ""}{t("已断开并隐藏")}</strong><span>{t("在该主机执行下面命令，可停止服务并删除 AgentFleets 程序、身份和连接数据。Codex 会话与项目文件不会被删除。")}</span></div></div>
            <div className="uninstall-command"><code>{uninstallCommand}</code><button className="button button--quiet" type="button" onClick={async () => { try { await copyText(uninstallCommand); setCopied(true); } catch (error) { onToast("danger", errorMessage(error)); } }}><Copy size={15} />{copied ? t("已复制") : t("复制卸载命令")}</button></div>
            <div className="modal-actions"><button className="button button--primary" type="button" onClick={onClose}>{t("完成")}</button></div>
          </>
        ) : (
          <>
            <div className="remove-machine-warning"><AlertTriangle size={19} /><div><strong>{t("将立即吊销")}{locale() === "en" ? " " : ""}{machine.name}</strong><span>{t("Agent 会断开，相关项目、会话和待审批项将从活动面板隐藏。云端审计记录仍会保留。")}</span></div></div>
            <div className="remove-machine-facts"><span>{t("主机")}</span><strong>{machine.name}</strong><span>{t("系统")}</span><strong>{machine.os} · {machine.arch}</strong><span>{t("项目")}</span><strong>{machine.projects.length} {locale() === "en" ? " " : ""}{t("个")}</strong></div>
            <div className="modal-actions"><button className="button button--quiet" type="button" onClick={onClose} disabled={busy}>{t("取消")}</button><button className="button button--danger" type="button" onClick={() => void remove()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{busy ? t("正在移除") : t("确认移除主机")}</button></div>
          </>
        )}
      </section>
    </div>
  );
}

function CreateSessionDialog({ open, machines, selectedMachineId, initialProject, onClose, onCreate, onToast }: { open: boolean; machines: Machine[]; selectedMachineId?: string; initialProject?: Project; onClose: () => void; onCreate: (machineId: string, projectId: string, title: string) => Promise<void>; onToast: (tone: Toast["tone"], message: string) => void }) {
  const writableMachines = machines.filter((machine) => machine.reachability === "live" && machine.compatibility === "compatible" && machine.identity === "paired");
  const initialMachine = writableMachines.find((machine) => machine.id === selectedMachineId) ?? writableMachines[0];
  const [machineId, setMachineId] = useState(initialMachine?.id ?? "");
  const [projectId, setProjectId] = useState(initialMachine?.projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  useEffect(() => { if (open) { const machine = writableMachines.find((item) => item.id === (initialProject?.machineId ?? selectedMachineId)) ?? writableMachines[0]; setMachineId(machine?.id ?? ""); setProjectId(initialProject?.id ?? machine?.projects[0]?.id ?? ""); setTitle(""); } }, [open, selectedMachineId, initialProject?.id]);
  useEffect(() => {
    if (!open || !machineId) return;
    const controller = new AbortController();
    const loadProjects = async () => {
      const projects: Project[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await api.projects({ machineId, limit: 100, ...(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        projects.push(...page.items);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error(t("项目列表加载未完成，请重新打开创建会话窗口"));
        if (cursor) seen.add(cursor);
      } while (cursor);
      const items = initialProject?.machineId === machineId && !projects.some((item) => item.id === initialProject.id) ? [initialProject, ...projects] : projects;
      setProjectOptions(items);
      setProjectId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
    };
    void loadProjects().catch((error) => { if (!controller.signal.aborted) onToast("danger", errorMessage(error)); });
    return () => controller.abort();
  }, [open, machineId, initialProject?.id]);
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal modal--compact" role="dialog" aria-modal="true" aria-labelledby="new-session-title"><div className="modal-head"><div><div className="eyebrow">New conversation</div><h2 id="new-session-title">{t("创建会话")}</h2></div><IconButton label={t("关闭")} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>{writableMachines.length === 0 ? <div className="modal-empty"><Unplug size={24} /><h3>{t("没有可用主机")}</h3><p>{t("连接在线主机并完成项目发现后，可以创建会话。")}</p></div> : <form className="stack-form" onSubmit={async (event) => { event.preventDefault(); if (!machineId || !projectId || !title.trim()) return; setBusy(true); try { await onCreate(machineId, projectId, title.trim()); onClose(); } catch (error) { onToast("danger", errorMessage(error)); } finally { setBusy(false); } }}><label><span>{t("主机")}</span><select value={machineId} onChange={(event) => { setMachineId(event.target.value); setProjectId(""); setProjectOptions([]); }}>{writableMachines.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>{t("项目")}</span><select value={projectId} title={projectOptions.find((project) => project.id === projectId)?.pathHint} onChange={(event) => setProjectId(event.target.value)} required>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.alias} · {project.pathHint}</option>)}</select></label><label><span>{t("会话名称")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("例如：修复结算页测试")} required autoFocus /></label><p className="subtle">{t("会话在所选主机和项目中执行。")}</p><button className="button button--primary button--full" disabled={busy || !projectId}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{locale() === "en" ? " " : ""}{t("创建会话")}</button></form>}</section></div>;
}

function projectAliasFromPath(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return leaf.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "").slice(0, 64) || "project";
}

const CUSTOM_PROJECT_LOCATION = "__custom__";

function projectParentPath(path: string): string | undefined {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return path.trim().startsWith("/") ? "/" : undefined;
  const boundary = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (boundary < 0) return undefined;
  if (boundary === 0) return trimmed[0];
  if (boundary === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, boundary);
}

function projectLocationOptions(machine: Machine | undefined): Array<{ path: string; projects: string[] }> {
  const choices = new Map<string, string[]>();
  for (const project of machine?.projects ?? []) {
    const parent = projectParentPath(project.pathHint);
    if (!parent) continue;
    const projects = choices.get(parent) ?? [];
    if (!projects.includes(project.alias)) projects.push(project.alias);
    choices.set(parent, projects);
  }
  return [...choices].map(([path, projects]) => ({ path, projects }));
}

function projectPathAt(parent: string, name: string): string {
  if (!parent) return name;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${name}` : `${parent}${separator}${name}`;
}

function CreateProjectDialog({ open, machines, selectedMachineId, onClose, onCreate, onToast }: { open: boolean; machines: Machine[]; selectedMachineId?: string; onClose: () => void; onCreate: (machineId: string, path: string, alias: string, createDirectory: boolean) => Promise<void>; onToast: (tone: Toast["tone"], message: string) => void }) {
  const writableMachines = machines.filter((machine) => machine.reachability === "live" && machine.compatibility === "compatible" && machine.identity === "paired" && machine.maintenanceCapabilities?.includes("project.add"));
  const [machineId, setMachineId] = useState("");
  const [location, setLocation] = useState(CUSTOM_PROJECT_LOCATION);
  const [folderName, setFolderName] = useState("");
  const [path, setPath] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [createDirectory, setCreateDirectory] = useState(true);
  const [busy, setBusy] = useState(false);
  const activeMachine = writableMachines.find((machine) => machine.id === machineId);
  const locations = projectLocationOptions(activeMachine);
  const effectivePath = location === CUSTOM_PROJECT_LOCATION ? path.trim() : folderName.trim() ? projectPathAt(location, folderName.trim()) : "";
  useEffect(() => {
    if (!open) return;
    const machine = writableMachines.find((item) => item.id === selectedMachineId) ?? writableMachines[0];
    setMachineId(machine?.id ?? "");
    setLocation(projectLocationOptions(machine)[0]?.path ?? CUSTOM_PROJECT_LOCATION);
    setFolderName(""); setPath(""); setAlias(""); setAliasEdited(false); setCreateDirectory(true);
  }, [open, selectedMachineId]);
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal modal--compact" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="modal-head"><div><div className="eyebrow">New project</div><h2 id="new-project-title">{t("创建项目")}</h2></div><IconButton label={t("关闭")} disabled={busy} onClick={onClose}><X size={18} /></IconButton></div>{writableMachines.length === 0 ? <div className="modal-empty"><Unplug size={24} /><h3>{t("没有支持创建项目的在线主机")}</h3><p>{t("请先更新并连接主机上的 Agent。")}</p></div> : <form className="stack-form" onSubmit={async (event) => { event.preventDefault(); if (!machineId || !effectivePath || !alias.trim()) return; setBusy(true); try { await onCreate(machineId, effectivePath, alias.trim(), location === CUSTOM_PROJECT_LOCATION ? createDirectory : true); onClose(); } catch (error) { onToast("danger", errorMessage(error)); } finally { setBusy(false); } }}><label><span>{t("主机")}</span><select value={machineId} onChange={(event) => { const nextMachine = writableMachines.find((machine) => machine.id === event.target.value); setMachineId(event.target.value); setLocation(projectLocationOptions(nextMachine)[0]?.path ?? CUSTOM_PROJECT_LOCATION); setFolderName(""); setPath(""); setAlias(""); setAliasEdited(false); setCreateDirectory(true); }}>{writableMachines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label><label><span>{t("创建位置")}</span><select value={location} title={location === CUSTOM_PROJECT_LOCATION ? t("自定义完整路径") : location} onChange={(event) => { setLocation(event.target.value); setFolderName(""); setPath(""); setAlias(""); setAliasEdited(false); setCreateDirectory(true); }}>{locations.map((choice) => <option key={choice.path} value={choice.path}>{t("{0}（与{1}同级）", choice.path, choice.projects.length === 1 ? choice.projects[0] : count(choice.projects.length, "个项目"))}</option>)}<option value={CUSTOM_PROJECT_LOCATION}>{t("自定义完整路径")}</option></select></label>{location === CUSTOM_PROJECT_LOCATION ? <label><span>{t("项目路径")}</span><input value={path} onChange={(event) => { const next = event.target.value; setPath(next); if (!aliasEdited) setAlias(projectAliasFromPath(next)); }} placeholder={t("例如：/home/me/projects/my-app")} required autoFocus /></label> : <><label><span>{t("新项目文件夹")}</span><input value={folderName} onChange={(event) => { const next = event.target.value; setFolderName(next); if (!aliasEdited) setAlias(projectAliasFromPath(next)); }} pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,63}" placeholder="my-app" required autoFocus /></label><div className="project-path-preview" aria-live="polite"><span>{t("将创建在")}</span><code>{effectivePath || projectPathAt(location, "my-app")}</code></div></>}<label><span>{t("项目名称")}</span><input value={alias} onChange={(event) => { setAlias(event.target.value); setAliasEdited(true); }} pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,63}" placeholder="my-app" required /></label>{location === CUSTOM_PROJECT_LOCATION && <label className="checkbox-row"><input type="checkbox" checked={createDirectory} onChange={(event) => setCreateDirectory(event.target.checked)} /><span>{t("路径不存在时创建目录")}</span></label>}<p className="subtle">{location === CUSTOM_PROJECT_LOCATION ? t("路径必须是主机上的绝对路径；只会创建最后一级目录。") : t("新项目会创建在所选目录中，与现有项目位于同一层级。")}</p><button className="button button--primary button--full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <FolderGit2 size={16} />}{busy ? t("正在创建") : t("创建项目")}</button></form>}</section></div>;
}

function App() {
  useLocale();
  const [catalogCollapsed, setCatalogCollapsed] = useState(() => {
    try { return localStorage.getItem(CATALOG_COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(CATALOG_COLLAPSED_KEY, String(catalogCollapsed)); } catch { /* Layout still works when browser storage is unavailable. */ }
  }, [catalogCollapsed]);
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [authKnown, setAuthKnown] = useState(false);
  const [route, setRoute] = useState(() => routeFromPath(location.pathname));
  const view = route.view;
  const routeRef = useRef(route);
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(route.machineId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(route.sessionId);
  const [detail, setDetail] = useState<SessionDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProject, setCreateProject] = useState<Project>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [removeMachine, setRemoveMachine] = useState<Machine>();
  useMobileViewport();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dashboardRef = useRef(dashboard);
  const detailRef = useRef(detail);
  const selectedSessionRef = useRef(selectedSessionId);
  const detailRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  const inFlightDetail = useRef<{ id: string; promise: Promise<void>; queued: boolean } | undefined>(undefined);
  const dashboardRequest = useRef(0);
  dashboardRef.current = dashboard;
  detailRef.current = detail;
  selectedSessionRef.current = selectedSessionId;

  const applyRoute = useCallback((next: AppRoute) => {
    routeRef.current = next;
    setRoute(next);
    const id = next.sessionId;
    if (id !== selectedSessionRef.current) {
      selectedSessionRef.current = id;
      detailRequest.current.controller?.abort();
      detailRequest.current.generation += 1;
      setSelectedSessionId(id);
      setDetail(undefined);
      setDetailLoading(Boolean(id));
    }
    const session = dashboardRef.current?.sessions.find((item) => item.id === id);
    setSelectedMachineId((current) => next.machineId ?? session?.machineId ?? (id ? undefined : ["security", "approvals"].includes(next.view) ? current : dashboardRef.current?.machines[0]?.id));
  }, []);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const path = routePath(next);
    if (location.pathname !== path || location.search || location.hash) history[replace ? "replaceState" : "pushState"](history.state, "", path);
    applyRoute(next);
  }, [applyRoute]);

  const selectSession = useCallback((id?: string) => {
    navigate({ view: "fleet", ...(id ? { sessionId: id } : { machineId: selectedMachineId }) });
  }, [navigate, selectedMachineId]);

  const selectMachine = useCallback((id: string) => {
    navigate({ view: routeRef.current.view === "hosts" ? "hosts" : "fleet", machineId: id });
  }, [navigate]);

  function setView(next: View) {
    navigate({ view: next, ...(["fleet", "hosts", "usage"].includes(next) ? { machineId: selectedMachineId } : {}) });
  }

  useEffect(() => {
    // Browser history restores state only; it must never rewrite the visited URL.
    const pop = () => applyRoute(routeFromPath(location.pathname));
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [applyRoute]);

  const toast = useCallback((tone: Toast["tone"], message: string) => {
    const id = crypto.randomUUID();
    setToasts((items) => [...items, { id, tone, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);

  const loadDashboard = useCallback(async (silent = false) => {
    const generation = ++dashboardRequest.current;
    try {
      const next = await api.dashboard();
      if (generation !== dashboardRequest.current) return;
      setDashboard(next);
      const selected = next.sessions.find((session) => session.id === selectedSessionRef.current);
      setSelectedMachineId((current) => routeRef.current.machineId ?? selected?.machineId ?? (current && next.machines.some((machine) => machine.id === current) ? current : next.machines[0]?.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setDashboard(undefined);
      else if (!silent) toast("danger", errorMessage(error));
    } finally {
      setAuthKnown(true);
    }
  }, [toast]);

  const loadDetail = useCallback(async function refreshDetail(id?: string, silent = false): Promise<void> {
    if (id !== selectedSessionRef.current) return;
    const active = inFlightDetail.current;
    if (id && active?.id === id && !detailRequest.current.controller?.signal.aborted) {
      active.queued = true;
      return active.promise;
    }
    detailRequest.current.controller?.abort();
    const generation = ++detailRequest.current.generation;
    if (!id) { setDetail(undefined); setDetailLoading(false); return; }
    const controller = new AbortController();
    detailRequest.current.controller = controller;
    if (!silent) setDetailLoading(true);
    const pending = { id, promise: Promise.resolve(), queued: false };
    inFlightDetail.current = pending;
    pending.promise = (async () => {
      try {
        const incoming = await api.session(id, controller.signal);
        if (generation === detailRequest.current.generation && id === selectedSessionRef.current) {
          setSelectedMachineId(incoming.session.machineId);
          setDetail((current) => {
            const next = current?.session.id === incoming.session.id
              ? { ...incoming, commands: mergeCommandReceipts(current.commands ?? [], incoming.commands ?? []) } : incoming;
            if (current?.session.cloudImageRevision !== next.session.cloudImageRevision) return next;
            if (!current || current.session.id !== next.session.id || current.session.contentEpoch !== next.session.contentEpoch || current.session.projectionEpoch !== next.session.projectionEpoch || !current.events.length || !next.events.length) return next;
            const firstNew = next.events[0].sessionSeq;
            if (current.events.at(-1)!.sessionSeq < firstNew - 1) return next;
            const older = current.events.filter((event) => event.sessionSeq < firstNew && !event.id.startsWith("volatile-"));
            return older.length ? { ...next, events: [...older, ...next.events], historyPage: { ...next.historyPage!, nextBeforeSeq: current.historyPage?.nextBeforeSeq ?? null } } : next;
          });
        }
      } catch (error) {
        if (!controller.signal.aborted && generation === detailRequest.current.generation) {
          if (error instanceof ApiError && error.code === "SESSION_DELETED") { toast("info",t("主机已确认删除，会话已从面板移除。")); navigate({view:"fleet",machineId:detailRef.current?.session.machineId}); }
          else if (!silent) toast("danger",errorMessage(error));
        }
      } finally {
        if (generation === detailRequest.current.generation) setDetailLoading(false);
        if (inFlightDetail.current === pending) inFlightDetail.current = undefined;
        if (pending.queued && generation === detailRequest.current.generation && id === selectedSessionRef.current) void refreshDetail(id, true);
      }
    })();
    return pending.promise;
  }, [toast,navigate]);

  const applyVolatile = useCallback((update: VolatileUpdate) => {
    setDetail((current) => {
      if (!current || current.session.id !== update.logicalSessionId) return current;
      const id = `volatile-${update.eventType}-${update.nativeTurnId}-${update.nativeItemId ?? "turn"}`;
      const delta = typeof update.payload.delta === "string" ? update.payload.delta : "";
      const diffText = typeof update.payload.diff === "string" ? update.payload.diff : "";
      const existing = current.events.find((event) => event.id === id);
      const bounded = (value: string) => value.length > 128_000 ? value.slice(-128_000) : value;
      const next: TimelineEvent = {
        id,
        sessionSeq: current.session.sessionSeq + 1,
        type: update.eventType,
        occurredAt: existing?.occurredAt ?? new Date().toISOString(),
        actor: update.eventType === "agent_message.delta" ? "agent" : "system",
        title: update.eventType === "agent_message.delta" ? t("Codex · 实时") : update.eventType === "command_output.delta" ? t("命令输出 · 实时") : t("变更预览 · 实时"),
        body: update.eventType === "agent_message.delta" ? bounded(`${existing?.body ?? ""}${delta}`) : update.eventType === "turn_diff.delta" ? t("正在接收最终变更…") : null,
        output: update.eventType === "command_output.delta" ? bounded(`${existing?.output ?? ""}${delta}`) : null,
        diff: update.eventType === "turn_diff.delta" ? volatileDiff(diffText) : null,
        payloadState: "present",
      };
      return {
        ...current,
        events: existing
          ? current.events.map((event) => event.id === id ? next : event)
          : [...current.events, next],
      };
    });
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);
  useEffect(() => {
    // The collection URL selects a default once, then records its stable ID.
    // Explicit missing/deleted IDs stay visible instead of silently selecting another host.
    if (dashboard && selectedMachineId && !route.machineId && !route.sessionId && ["fleet", "hosts", "usage"].includes(route.view) && /^\/(hosts|workbench|usage)\/?$/.test(location.pathname)) {
      navigate({ view: route.view, machineId: selectedMachineId }, true);
    }
  }, [dashboard, selectedMachineId, route, navigate]);
  useEffect(() => { if (dashboard) void loadDetail(selectedSessionId); }, [dashboard?.user.id, selectedSessionId]);
  useEffect(() => {
    if (!dashboard) return;
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToFleet(() => { const focused = detailRef.current?.session ?? dashboardRef.current?.sessions.find((session) => session.id === selectedSessionRef.current); return focused ? [focused] : []; }, () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void loadDashboard(true); void loadDetail(selectedSessionRef.current, true); }, 120);
    }, setConnected, applyVolatile);
    return () => { window.clearTimeout(refreshTimer); unsubscribe(); };
  }, [dashboard?.user.id, loadDashboard, loadDetail, applyVolatile]);
  useEffect(() => {
    if (!dashboard) return;
    const refresh = () => { if (document.visibilityState !== "hidden") { void loadDashboard(true); void loadDetail(selectedSessionRef.current, true); } };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [dashboard?.user.id, loadDashboard, loadDetail]);
  useEffect(() => {
    if (!(detail?.commands ?? []).some((command) => commandPending(command) || command.state === "unknown")) return;
    const id = detail!.session.id;
    const controller = new AbortController();
    let checking = false;
    const refresh = async () => {
      if (checking) return;
      checking = true;
      try {
        // Receipts must settle even if history is slow, unavailable, or streaming.
        const commands = await api.commandReceipts(id, controller.signal);
        if (!controller.signal.aborted && selectedSessionRef.current === id) setDetail(current => current?.session.id === id
          ? { ...current, commands: mergeCommandReceipts(current.commands ?? [], commands) } : current);
      } catch { /* Keep the actual pending state and retry this read, never resend. */ }
      finally { checking = false; }
      if (!controller.signal.aborted && selectedSessionRef.current === id) { void loadDetail(id, true); void loadDashboard(true); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [detail?.session.id, detail?.commands?.map((command) => `${command.id}:${command.state}`).join("|"), loadDetail, loadDashboard]);

  const selectedMachine = useMemo(() => dashboard?.machines.find((machine) => machine.id === selectedMachineId), [dashboard, selectedMachineId]);
  const displayedSession = detail && detail.session.id === selectedSessionId ? detail.session : undefined;

  if (!authKnown) return <main className="boot-screen"><span className="brand-glyph"><Radio size={19} /></span><LoaderCircle className="spin" size={22} /><span>{t("正在接入 Control Plane")}</span></main>;
  if (!dashboard) return <Login onLogin={(next) => { setDashboard(next); const session = next.sessions.find((item) => item.id === selectedSessionRef.current); setSelectedMachineId(routeRef.current.machineId ?? session?.machineId ?? next.machines[0]?.id); }} />;

  async function refreshAll() { await Promise.all([loadDashboard(true), loadDetail(selectedSessionId, true)]); }
  async function loadEarlierHistory() {
    const current = detailRef.current;
    if (!current || current.historyPage?.nextBeforeSeq == null || historyLoading) return;
    const id = current.session.id;
    setHistoryLoading(true);
    try {
      const page = await api.history(id, current.historyPage.nextBeforeSeq);
      setDetail((latest) => {
        if (!latest || latest.session.id !== id || latest.session.contentEpoch !== page.contentEpoch || latest.session.projectionEpoch !== page.projectionEpoch) return latest;
        const events = [...page.events.filter((event) => !latest.events.some((existing) => existing.id === event.id)), ...latest.events].sort((left, right) => left.sessionSeq - right.sessionSeq);
        return { ...latest, events, historyPage: { ...latest.historyPage!, nextBeforeSeq: page.nextBeforeSeq } };
      });
    } catch (error) { toast("danger", errorMessage(error)); } finally { setHistoryLoading(false); }
  }
  function openCreate(project?: Project) { setCreateProject(project); setCreateOpen(true); }
  async function submitCommand(input: Parameters<typeof api.command>[1]) {
    if (!detail || detail.session.id !== selectedSessionRef.current) throw new Error(t("会话已切换，请在当前会话重试"));
    const sessionId = detail.session.id;
    const storageKey = `agentfleet.mutation:${dashboard!.user.id}:${sessionId}`;
    const signature = JSON.stringify({ ...input, clientMutationId: undefined });
    let clientMutationId = input.clientMutationId;
    try {
      clientMutationId = commandMutationId(sessionStorage, storageKey, signature, clientMutationId, detailRef.current?.commands ?? []);
    } catch { /* Some browsers deny access to sessionStorage itself. */ }
    const result = await api.command(sessionId, { ...input, clientMutationId });
    try { rememberCommandReceipt(sessionStorage, storageKey, clientMutationId, result.command.id); } catch { /* Storage unavailable. */ }
    if (result.command.id) setDetail((current) => current?.session.id === sessionId ? {
      ...current, commands: mergeCommandReceipts(current.commands ?? [], [result.command, ...(current.commands ?? []).filter((command) => command.id !== result.command.id)]),
    } : current);
    return result;
  }
  async function claimSession() {
    if (!detail || !selectedSessionId || !detail.session.nativeThreadId) return;
    try {
      await submitCommand({
        type: "thread.claim",
        payload: {},
        clientMutationId: crypto.randomUUID(),
        precondition: {
          nativeThreadId: detail.session.nativeThreadId,
          threadControlVersion: detail.session.threadControlVersion,
          expectedActiveTurnId: null,
          projectLeaseVersion: detail.session.projectLeaseVersion,
        },
      });
      toast("info", t("接管请求已提交，可在操作进度中查看主机结果"));
      await refreshAll();
    } catch (error) {
      toast("danger", errorMessage(error));
      throw error;
    }
  }
  async function continueInManagedSession() {
    if (!detail || detail.session.historyMode !== "paginated") return;
    const source = detail.session;
    try {
      const result = await api.createSession(source.machineId, source.projectId, t("{0} · 新会话", source.title));
      setSelectedMachineId(source.machineId);
      selectSession(result.session.id);
      toast("success", t("已在同项目新建会话，不继承旧会话上下文"));
      await loadDashboard(true);
      await loadDetail(result.session.id, true);
    } catch (error) {
      toast("danger", errorMessage(error));
      throw error;
    }
  }
  async function releaseManagement() {
    if (!detail || !selectedSessionId || !detail.session.nativeThreadId) return;
    try {
      await submitCommand({
        type: "thread.release",
        payload: {},
        clientMutationId: crypto.randomUUID(),
        precondition: {
          nativeThreadId: detail.session.nativeThreadId,
          threadControlVersion: detail.session.threadControlVersion,
          expectedActiveTurnId: null,
          projectLeaseVersion: detail.session.projectLeaseVersion,
        },
      });
      toast("info", t("正在等待主机释放面板写入占用，请以操作回执为准"));
      await refreshAll();
    } catch (error) {
      toast("danger", errorMessage(error));
      throw error;
    }
  }
  async function sendPrompt(prompt: string, settings?: CodexSettings, images?: string[], additions?: TurnAdditions) { if (parseCodexCommand(prompt)) throw new Error(t("请使用面板命令入口；未将斜杠命令作为聊天消息发送。")); if (!detail) return; try { await submitCommand({ type: "turn.start", payload: { prompt, ...(images?.length ? { images } : {}), ...additions, ...(settings ? { settings } : {}) }, clientMutationId: crypto.randomUUID(), precondition: { executionSegmentId: detail.session.executionSegmentId, threadControlVersion: detail.session.threadControlVersion, expectedActiveTurnId: null, projectLeaseVersion: detail.session.projectLeaseVersion } }); toast("info", t("消息已提交，等待主机处理")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function queuePrompt(prompt: string, settings?: CodexSettings, images?: string[], additions?: TurnAdditions) { if (parseCodexCommand(prompt)) throw new Error(t("请使用面板命令入口；未将斜杠命令作为聊天消息发送。")); if (!detail?.session.activeTurnId) return; try { await submitCommand({ type: "turn.queue", payload: { prompt, ...(images?.length ? { images } : {}), ...additions, ...(settings ? { settings } : {}) }, clientMutationId: crypto.randomUUID(), expiresInSeconds: 3600, precondition: { executionSegmentId: detail.session.executionSegmentId, threadControlVersion: detail.session.threadControlVersion, expectedActiveTurnId: detail.session.activeTurnId, projectLeaseVersion: detail.session.projectLeaseVersion, queueVersion: detail.session.queueVersion } }); toast("info", t("排队请求已提交，请查看操作进度")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function steerPrompt(prompt: string, images?: string[], additions?: TurnAdditions) { if (parseCodexCommand(prompt)) throw new Error(t("请使用面板命令入口；未将斜杠命令作为聊天消息发送。")); if (!detail?.session.activeTurnId) return; try { await submitCommand({ type: "turn.steer", payload: { prompt, ...(images?.length ? { images } : {}), ...additions }, clientMutationId: crypto.randomUUID(), precondition: { nativeTurnId: detail.session.activeTurnId, turnControlVersion: detail.session.turnControlVersion } }); toast("info", t("追加请求已提交，等待主机确认")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function cancelQueuedTurn(queueItemId: string) { if (!detail) return; try { await api.cancelQueuedTurn(detail.session.id, queueItemId); toast("info", t("队列项已取消")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function cancelTurn() { if (!detail?.session.activeTurnId) return; try { await submitCommand({ type: "turn.cancel", payload: {}, clientMutationId: crypto.randomUUID(), precondition: { nativeTurnId: detail.session.activeTurnId, turnControlVersion: detail.session.turnControlVersion } }); toast("info", t("停止请求已提交，等待主机确认")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function decideApproval(decision: "accept" | "decline") { const approval = detail?.approval; if (!approval) return; try { await api.decideApproval(approval.id, { decision, approvalVersion: approval.approvalVersion, actionHash: approval.actionHash }); toast(decision === "accept" ? "success" : "info", decision === "accept" ? t("已仅本次允许") : t("已拒绝操作")); await refreshAll(); } catch (error) { toast("danger", errorMessage(error)); throw error; } }
  async function updateMachineAlias(alias: string | null) { if (!selectedMachine) return; try { await api.updateMachineAlias(selectedMachine.id, alias); toast("success", alias ? t("主机显示名称已改为 {0}", alias) : t("已恢复显示真实 hostname")); await loadDashboard(true); } catch (error) { toast("danger", errorMessage(error)); throw error; } }

  function openApproval(sessionId: string) { selectSession(sessionId); }

  return (
    <div className={`app-shell${view === "fleet" && (displayedSession || detailLoading) ? " app-shell--conversation" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-glyph"><ThemeEmblem /></span><span>AgentFleets</span></div>
        <WorldClocks side="left" />
        <nav className="primary-nav" aria-label={t("主导航")}>
          <button aria-current={view === "fleet" ? "page" : undefined} className={view === "fleet" ? "active" : ""} onClick={() => { setView("fleet"); }}><MonitorDot size={16} />{t("工作台")}</button>
          <button aria-current={view === "hosts" ? "page" : undefined} className={view === "hosts" ? "active" : ""} onClick={() => { setView("hosts"); }}><Server size={16} />{t("主机")}</button>
          {(dashboard.stats.approvals > 0 || view === "approvals") && <button aria-current={view === "approvals" ? "page" : undefined} className={view === "approvals" ? "active" : ""} onClick={() => { setView("approvals"); }}><KeyRound size={16} />{t("待处理")}{locale() === "en" ? " " : ""}{dashboard.stats.approvals > 0 && <span className="nav-count">{dashboard.stats.approvals}</span>}</button>}
          <button aria-current={view === "usage" ? "page" : undefined} className={view === "usage" ? "active" : ""} onClick={() => { setView("usage"); }}><BarChart3 size={16} />{t("消耗")}</button>
          <button aria-current={view === "security" ? "page" : undefined} className={view === "security" ? "active" : ""} onClick={() => { setView("security"); }}><ShieldCheck size={16} />{t("设置")}</button>
        </nav>
        <WorldClocks side="right" />
        <div className="topbar-actions"><LanguageSwitcher compact /><span className="account-label">{dashboard.user.displayName}</span><IconButton label={t("退出登录")} onClick={async () => { await api.logout(); setDashboard(undefined); setConnected(false); }}><LogOut size={16} /></IconButton></div>
      </header>
      {view === "fleet" ? <div className={`fleet-layout${catalogCollapsed ? " fleet-layout--catalog-collapsed" : ""}`}>
        <MachineRail machines={dashboard.machines} sessions={dashboard.activitySessions ?? dashboard.sessions} connected={connected} selectedId={selectedMachineId} onSession={selectSession} onHost={id => navigate({ view: "hosts", machineId: id })} onSelect={selectMachine} onPair={() => setPairOpen(true)} />
        <main className="fleet-main">
          <div className="catalog-toggle-bar"><button type="button" className="catalog-toggle" aria-label={catalogCollapsed ? t("展开项目与会话") : t("收起项目与会话")} title={catalogCollapsed ? t("展开项目与会话") : t("收起项目与会话，让对话更宽")} aria-expanded={!catalogCollapsed} aria-controls="workbench-catalog" onClick={() => setCatalogCollapsed((value) => !value)}>{catalogCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}<span>{catalogCollapsed ? t("展开") : t("收起列表")}</span></button></div>
          <div id="workbench-catalog" className="fleet-catalog-content" role="region" aria-label={t("项目与会话列表")} tabIndex={0}>
          {selectedMachine && <><MachineSummaryHeader machine={selectedMachine} onAliasChange={updateMachineAlias} /><button className="catalog-more" type="button" onClick={() => setView("hosts")}>{t("管理主机与默认设置")}</button>{selectedMachine.discovery?.state !== "ready" && <DiscoveryStatus discovery={selectedMachine.discovery} />}</>}
          {route.machineId && !selectedMachine ? <section role="status"><h1>{t("该主机不存在或已移除")}</h1><p>{t("请从左侧选择其他主机，或添加新主机。")}</p></section> : <WorkspaceCatalog machineId={selectedMachineId} selectedSession={displayedSession} refreshKey={dashboard.serverTime} onSelect={selectSession} onCreate={openCreate} onCreateProject={() => setCreateProjectOpen(true)} />}
          </div>
        </main>
        <SessionInspector detail={displayedSession ? detail : undefined} loading={detailLoading} draftOwner={dashboard.user.id} onLoadHistory={() => void loadEarlierHistory()} historyLoading={historyLoading} onRefresh={() => void loadDetail(selectedSessionId)} onClaim={claimSession} onContinueManaged={continueInManagedSession} onReleaseManagement={releaseManagement} onSend={sendPrompt} onQueue={queuePrompt} onSteer={steerPrompt} onCancelQueued={cancelQueuedTurn} onCancel={cancelTurn} onApproval={decideApproval} onNewSession={() => { if (displayedSession) openCreate({ id: displayedSession.projectId, machineId: displayedSession.machineId, alias: displayedSession.projectAlias, pathHint: t("当前会话项目"), syncContent: true, retentionDays: 7 }); }} onClose={() => selectSession(undefined)} />
      </div> : view === "hosts" ? <HostsView machines={dashboard.machines} selectedId={selectedMachineId} onSelect={selectMachine} onPair={() => setPairOpen(true)} onRemove={setRemoveMachine} onChanged={refreshAll} renderCompatibility={(machine) => <CompatibilityProfileCard machine={machine} profile={dashboard.compatibilityProfile} />} /> : view === "approvals" ? <ApprovalsView approvals={dashboard.pendingApprovals} onOpen={openApproval} onBack={() => setView("fleet")} /> : view === "usage" ? <UsageView machines={dashboard.machines} selectedId={selectedMachineId} onSelect={id=>navigate({view:"usage",machineId:id})} onSession={selectSession} /> : <SettingsView dashboard={dashboard} onUpdated={refreshAll} onToast={toast} />}
      <PairMachineDialog open={pairOpen} onClose={() => setPairOpen(false)} onPaired={(machineId) => { if (machineId) navigate({ view: "fleet", machineId }); void loadDashboard(); }} onToast={toast} />
      <RemoveMachineDialog machine={removeMachine} onClose={() => setRemoveMachine(undefined)} onRemoved={() => loadDashboard(true)} onToast={toast} />
      <CreateSessionDialog open={createOpen} machines={dashboard.machines} selectedMachineId={selectedMachineId} initialProject={createProject} onClose={() => setCreateOpen(false)} onToast={toast} onCreate={async (machineId, projectId, title) => { const result = await api.createSession(machineId, projectId, title); setSelectedMachineId(machineId); selectSession(result.session.id); toast("success", t("受管会话已创建")); await loadDashboard(true); }} />
      <CreateProjectDialog open={createProjectOpen} machines={dashboard.machines} selectedMachineId={selectedMachineId} onClose={() => setCreateProjectOpen(false)} onToast={toast} onCreate={async (machineId, path, alias, createDirectory) => {
        let operation = await api.createProject(machineId, path, alias, createDirectory);
        const deadline = Date.now() + 120_000;
        while (operation.state === "accepted" || operation.state === "running") {
          if (Date.now() >= deadline) throw new Error(t("主机仍在处理项目，请稍后刷新项目列表"));
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          operation = await api.readHostOperation(operation.id);
        }
        if (operation.state !== "succeeded") throw new Error(operation.error?.message ?? t("项目创建未完成，请重试"));
        setSelectedMachineId(machineId);
        await loadDashboard(true);
        toast("success", t("项目 {0} 已添加", alias));
      }} />
      <div className="toast-stack" aria-live="polite">{toasts.map((item) => <div className={`toast toast--${item.tone}`} key={item.id}>{item.tone === "success" ? <Check size={16} /> : item.tone === "danger" ? <OctagonX size={16} /> : <CircleDot size={16} />}<span>{systemText(item.message)}</span></div>)}</div>
    </div>
  );
}

export default App;
