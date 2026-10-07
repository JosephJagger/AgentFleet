import { Settings2 } from "lucide-react";
import { ConfigDisclosureSummary } from "./ConfigDisclosureSummary";
import { HOST_CODEX_OPERATIONS } from "../lib/host-codex";
import { useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
import type { CommandReceipt, FleetSession, Machine, HostOperation } from "../lib/types";

const operations = {
  "windows.setup": "安装或修复 Windows 原生沙箱",
  "gateway.read": "查看网关账号状态", "remote.status": "查看原生远程控制状态", "voice.catalog": "实验：查看原生音色目录", "plugin.search": "实验：搜索原生插件",
  "subagents.read": "查看当前会话子代理",
  "files.search": "搜索项目原生文件", "files.list": "浏览项目原生目录", "terminal.run": "运行独立原生命令",
  "mcp.resource": "读取已列出的 MCP 资源", "mcp.call": "调用已列出的 MCP 工具",
  "workspaceMessages.read": "查看原生工作区公告", "windows.readiness": "检查 Windows 原生沙箱", "mcp.catalog": "查看 MCP 工具与资源",
  "goal.read": "查看目标与预算进度", "apps.installed": "查看已安装原生应用", "apps.read": "查看应用与工具说明", "sections.read": "查看原生会话分组", "section.create": "新建原生分组", "section.rename": "重命名原生分组", "section.delete": "删除原生分组", "section.move": "移动本会话到分组", "attachment.note": "保存原生会话备注", "attachment.remove": "移除面板保存的会话备注", "nativeQueue.update": "实验：修改原生排队消息", "nativeQueue.delete": "实验：删除原生排队消息", "nativeQueue.reorder": "实验：调整原生队列顺序", "diagnostics.read": "实验：查看原生运行诊断",
  "account.read": "查看原生登录状态", "account.login": "登录 ChatGPT 账号", "account.login.cancel": "取消此次登录", "account.logout": "退出原生账号",
  "usage.read": "读取官方用量", "resetCards.read": "查看重置卡", "resetCard.consume": "使用重置卡",
  "goal.set": "设置或调整目标", "goal.clear": "清除目标", "plugin.install": "安装插件", "plugin.uninstall": "卸载插件",
  "plugin.catalog": "浏览原生插件市场", "plugin.reconcile": "同步已安装插件", "marketplace.add": "添加 GitHub 插件市场", "marketplace.remove": "移除插件市场", "marketplace.upgrade": "更新插件市场", "memory.mode": "实验：设置本会话记忆", "memory.reset": "实验：重置原生记忆",
  "mcp.login": "授权 MCP 连接", "mcp.reload": "重新加载 MCP 配置", "skill.toggle": "启用或停用技能", "provider.read": "查看模型提供方能力", "config.requirements": "查看原生管理限制", "experiment.configure": "实验：配置运行中设置开关", "attachments.read": "查看原生会话附件",
  "memory.status": "实验：查看记忆状态", "history.search": "实验：搜索原生会话内容", "timeline.read": "实验：查看原生时间轴", "nativeQueue.read": "实验：查看原生队列", "turn.settings": "实验：调整当前任务设置",
} as const;
type Operation = keyof typeof operations;
const statusLabel = (status: string) => ({ available: "已读取", partialFailure: "部分未完成，请检查原生状态后再操作", notConfigured: "未配置原生管理限制", notApplicable: "此平台不适用", savedRequiresReconnect: "已保存；重新连接 Codex 后生效", unavailable: "未上报", completed: "主机已完成", reset: "重置卡已使用，额度已重新读取", alreadyRedeemed: "此操作已使用过重置卡，没有重复消耗", noCredit: "当前没有可用重置卡", nothingToReset: "当前额度无需重置，没有消耗卡片", loggedIn: "已登录", notLoggedIn: "未登录", awaitingAuthorization: "等待完成官方授权", applied: "设置已发布，本轮后续步骤按原生规则生效", targetUnavailable: "目标任务已不可更新，未修改设置" }[status] ?? status);
const experimentalOperation = (op: Operation) => ["voice.catalog", "plugin.search", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "turn.settings", "experiment.configure", "memory.mode", "memory.reset", "nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder", "diagnostics.read"].includes(op);
const needsConfirmation = (op: Operation) => !["gateway.read", "remote.status", "voice.catalog", "plugin.search", "subagents.read", "account.read", "usage.read", "resetCards.read", "goal.set", "mcp.login", "provider.read", "attachments.read", "memory.status", "history.search", "timeline.read", "nativeQueue.read", "config.requirements", "plugin.catalog", "goal.read", "apps.installed", "apps.read", "sections.read", "diagnostics.read", "workspaceMessages.read", "windows.readiness", "mcp.catalog", "mcp.resource", "files.search", "files.list"].includes(op);

const operationGroups = { account: "账号与额度", session: "会话与目标", integrations: "插件、应用与 MCP", workspace: "项目文件与命令", environment: "原生环境检查", experimental: "已验证的实验能力" } as const;
function operationGroup(op: Operation): keyof typeof operationGroups {
  if (experimentalOperation(op)) return "experimental";
  if (/^(gateway\.|account\.|usage\.|resetCard)/.test(op)) return "account";
  if (/^(subagents\.|goal\.|attachment|section)/.test(op)) return "session";
  if (/^(plugin\.|marketplace\.|apps\.|mcp\.|skill\.)/.test(op)) return "integrations";
  if (/^(files\.|terminal\.)/.test(op)) return "workspace";
  return "environment";
}

export function CodexOperationsPanel({ session, commands = [], machine, hostOperations = [], onChanged, groups, title, initialOperation }: { groups?: (keyof typeof operationGroups)[]; title?: string; initialOperation?: Operation; session?: FleetSession; commands?: CommandReceipt[]; machine?: Machine; hostOperations?: HostOperation[]; onChanged: () => void }) {
  const [operation, setOperation] = useState<Operation>(initialOperation ?? "usage.read");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [experimental, setExperimental] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState<string>();
  const receipt = commands.find(c => c.id === submitted);
  const hostReceipt = hostOperations.find(c => c.id === submitted);
  const hostPending = hostOperations.some(c => c.type === "codex.host" && ["accepted", "running", "unknown"].includes(c.state));
  const pending = hostPending || commands.some(c => c.type === "codex.manage" && ["accepted", "dispatching", "unknown"].includes(c.state));
  const result = (hostReceipt?.result?.codexResult as CommandReceipt["codexResult"]) ?? receipt?.codexResult;
  const allowed = machine ? machine.reachability === "live" && machine.maintenanceCapabilities?.includes("codex.host") === true : session?.actions?.manage?.allowed === true;
  const editable = (!experimentalOperation(operation) || experimental) && (operation !== "turn.settings" || !!session?.activeTurnId) && allowed && !busy && !pending;
  const input = (key: string, label: string, optional = false) => <label key={key}>{t(label)}<input value={fields[key] ?? ""} required={!optional} maxLength={key === "objective" ? 2000 : key === "uri" ? 2048 : 256} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>;
  async function run(cursor?: string) {
    if (!editable || needsConfirmation(operation) && !confirmed) return;
    const args: Record<string, unknown> = {};
    if (experimentalOperation(operation)) args.experimental = true;
    if (cursor) args.cursor = cursor;
    if (operation === "windows.setup") args.mode = fields.mode ?? "unelevated";
    if (operation === "files.search") args.query = fields.query?.trim();
    if (operation === "files.list" && fields.path?.trim()) args.path = fields.path.trim();
    if (operation === "terminal.run") {
      try { args.argv = JSON.parse(fields.argv || "[]"); } catch { setMessage(t("命令参数必须是 JSON 字符串数组。")); return; }
    }
    if (["mcp.resource", "mcp.call"].includes(operation)) args.name = fields.name?.trim();
    if (operation === "mcp.resource") args.uri = fields.uri?.trim();
    if (operation === "mcp.call") {
      args.tool = fields.tool?.trim();
      try { args.input = JSON.parse(fields.input || "{}"); } catch { setMessage(t("工具参数必须是有效的 JSON 对象。")); return; }
    }
    if (operation === "mcp.catalog" && fields.name?.trim()) args.name = fields.name.trim();
    if (operation === "apps.read") args.appId = fields.appId?.trim();
    if (["section.create", "section.rename"].includes(operation)) args.name = fields.name?.trim();
    if (["section.rename", "section.delete", "section.move"].includes(operation)) args.sectionId = fields.sectionId?.trim() || null;
    if (["attachment.note", "attachment.remove"].includes(operation)) args.identityKey = fields.identityKey?.trim();
    if (["attachment.note", "nativeQueue.update"].includes(operation)) args.text = fields.text?.trim();
    if (["nativeQueue.update", "nativeQueue.delete"].includes(operation)) args.submissionId = fields.submissionId?.trim();
    if (operation === "nativeQueue.reorder") args.submissionIds = (fields.submissionIds ?? "").split(/[\s,]+/).filter(Boolean);
    if (["history.search", "plugin.search"].includes(operation)) args.searchTerm = fields.searchTerm?.trim();
    if (operation === "turn.settings") {
      for (const key of ["model", "effort"]) if (fields[key]?.trim()) args[key] = fields[key].trim();
      if (fields.serviceTier) args.serviceTier = fields.serviceTier === "clear" ? null : fields.serviceTier;
      if (fields.summary) args.summary = fields.summary;
      if (!["model", "effort", "serviceTier", "summary"].some(key => key in args)) { setMessage(t("请至少选择一项需要修改的设置。")); return; }
    }
    if (operation === "account.login.cancel") args.loginId = fields.loginId?.trim();
    if (operation === "usage.read") args.scope = fields.scope ?? "account";
    if (operation === "resetCard.consume" && fields.creditId?.trim()) args.creditId = fields.creditId.trim();
    if (operation === "goal.set") {
      if (fields.objective?.trim()) args.objective = fields.objective.trim();
      args.status = fields.status ?? "paused";
      if (fields.tokenBudget) args.tokenBudget = Number(fields.tokenBudget);
    }
    for (const key of operation === "plugin.install" ? ["pluginName", "remoteMarketplaceName"] : operation === "plugin.uninstall" ? ["pluginId"] : ["mcp.login", "skill.toggle"].includes(operation) ? ["name"] : []) args[key] = fields[key]?.trim();
    if (operation === "marketplace.add") args.source = fields.source?.trim();
    if (["marketplace.remove", "marketplace.upgrade"].includes(operation) && fields.marketplaceName?.trim()) args.marketplaceName = fields.marketplaceName.trim();
    if (["experiment.configure", "memory.mode"].includes(operation)) args.enabled = fields.enabled !== "false";
    if (operation === "skill.toggle") args.enabled = fields.enabled !== "false";
    if (needsConfirmation(operation)) args.confirmed = true;
    setBusy(true); setMessage("");
    try {
      if (machine) {
        const response = await api.hostCodexOperation(machine.id, { operation, arguments: args }, crypto.randomUUID());
        setSubmitted(response.id);
      } else if (session) {
      const response = await api.command(session.id, { type: "codex.manage", clientMutationId: crypto.randomUUID(), payload: { operation, arguments: args },
        precondition: { nativeThreadId: session.nativeThreadId, executionSegmentId: session.executionSegmentId, threadControlVersion: session.threadControlVersion, expectedActiveTurnId: session?.activeTurnId ?? null, projectLeaseVersion: session.projectLeaseVersion } });
      setSubmitted(response.command.id);
      }
      setMessage(t("请求已提交，正在等待宿主机回执。")); onChanged();
    } catch (e) { setMessage(e instanceof Error ? e.message : t("操作失败")); }
    finally { setBusy(false); }
  }
  return <details className="codex-settings-panel codex-operations-panel config-disclosure"><ConfigDisclosureSummary icon={Settings2}>{t(title ?? "Codex 工具与账号")}</ConfigDisclosureSummary><div className="config-disclosure__body">
    <form className="stack-form" onSubmit={event => { event.preventDefault(); void run(); }}>
      <label className="checkbox-row"><input type="checkbox" checked={experimental} disabled={busy || pending} onChange={e => { setExperimental(e.target.checked); if (!e.target.checked && experimentalOperation(operation)) { setOperation(initialOperation ?? "usage.read"); setFields({}); setSubmitted(undefined); } setConfirmed(false); }} />{t("显示已验证的 Codex 实验接口")}</label>
      <label>{t("操作")}<select value={operation} disabled={busy || pending} onChange={event => { setOperation(event.target.value as Operation); setFields({}); setConfirmed(false); setMessage(""); setSubmitted(undefined); }}>{Object.entries(operationGroups).map(([group, title]) => { const entries = Object.entries(operations).filter(([key]) => operationGroup(key as Operation) === group && (!groups || groups.includes(group as keyof typeof operationGroups)) && (!groups || !session || !HOST_CODEX_OPERATIONS.includes(key)) && (!groups || !["nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(key)) && (!machine || HOST_CODEX_OPERATIONS.includes(key)) && (experimental || !experimentalOperation(key as Operation))); return entries.length ? <optgroup key={group} label={t(title)}>{entries.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</optgroup> : null; })}</select></label>
      {operation === "windows.setup" && <label>{t("安装方式")}<select value={fields.mode ?? "unelevated"} onChange={e=>{setFields({...fields,mode:e.target.value});setConfirmed(false);}}><option value="unelevated">{t("当前用户")}</option><option value="elevated">{t("管理员安装（需主机本地确认）")}</option></select></label>}
      {["account.login", "account.logout"].includes(operation) && <p>{t("这会修改宿主机默认 Codex 环境的登录状态，并影响使用该环境的其他原生会话。登录只在 OpenAI 官方页面完成，面板不接收密码或认证文件。")}</p>}
      {operation === "files.search" && input("query", "文件搜索词")}
      {operation === "files.list" && input("path", "项目内相对目录（留空使用会话目录）", true)}
      {operation === "terminal.run" && <><label>{t("命令参数数组")}<textarea maxLength={16000} placeholder={'["git", "status", "--short"]'} required value={fields.argv ?? ""} onChange={e => setFields({ ...fields, argv: e.target.value })} /></label><p>{t("直接在本会话目录执行，沿用本会话权限，最多运行 30 秒；不消耗模型额度，不创建 Codex 轮次。宿主机需要空闲。")}</p></>}
      {["mcp.resource", "mcp.call"].includes(operation) && input("name", "MCP 服务器名称")}
      {operation === "mcp.resource" && input("uri", "清单中的资源 URI")}
      {operation === "mcp.call" && <>{input("tool", "清单中的工具名称")}<label>{t("工具参数 JSON")}<textarea maxLength={16000} value={fields.input ?? "{}"} onChange={e => setFields({ ...fields, input: e.target.value })}/></label><p>{t("直接调用所选原生工具，可能修改外部服务；请核对名称和参数，不在此填写密码、API Key 或认证令牌。")}</p></>}
      {operation === "mcp.catalog" && input("name", "MCP 名称（留空读取全部）", true)}
      {operation === "windows.readiness" && <p>{t("仅检查 Windows 原生沙箱状态；其他平台会返回不适用，不会弹出安装或提权窗口。")}</p>}
      {operation === "apps.read" && input("appId", "应用 ID")}
      {operation.startsWith("section.") && <p>{t("这是默认 Codex 环境的原生分组；不改变面板项目、工作目录或访问权限。删除分组不会删除会话。")}</p>}
      {["section.create", "section.rename"].includes(operation) && input("name", "分组名称")}
      {["section.rename", "section.delete", "section.move"].includes(operation) && input("sectionId", "原生分组 ID（移动时留空移出分组）", operation === "section.move")}
      {["attachment.note", "attachment.remove"].includes(operation) && <>{input("identityKey", "备注标识")}{operation === "attachment.note" && <label>{t("备注内容")}<textarea maxLength={12000} required value={fields.text ?? ""} onChange={e => setFields({ ...fields, text: e.target.value })} /></label>}<p>{t("仅保存或移除面板备注，不修改原生文件附件；备注不会自动成为下一轮上下文。")}</p></>}
      {["nativeQueue.update", "nativeQueue.delete"].includes(operation) && input("submissionId", "原生队列消息 ID")}
      {operation === "nativeQueue.update" && <label>{t("新的排队消息")}<textarea maxLength={12000} required value={fields.text ?? ""} onChange={e => setFields({ ...fields, text: e.target.value })} /></label>}
      {operation === "nativeQueue.reorder" && <label>{t("按顺序输入全部原生队列 ID（每行一个）")}<textarea required value={fields.submissionIds ?? ""} onChange={e => setFields({ ...fields, submissionIds: e.target.value })} /></label>}
      {["nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(operation) && <p>{t("先读取原生队列再操作；只改变本会话的原生排队消息，不改变面板队列，也不会启动任务。")}</p>}
      {operation === "account.login.cancel" && input("loginId", "登录请求 ID")}
      {operation === "usage.read" && <><label>{t("用量范围")}<select value={fields.scope ?? "account"} onChange={e => setFields({ ...fields, scope: e.target.value })}><option value="account">{t("当前原生账号")}</option>{!machine && <option value="thread">{t("当前会话")}</option>}</select></label><p>{t("来自 Codex 官方用量接口；缺失数据不会按零计算，也不会加到面板已记录的 token 中。")}</p></>}
      {operation === "marketplace.add" && input("source", "GitHub 仓库 HTTPS 地址")}
      {["marketplace.remove", "marketplace.upgrade"].includes(operation) && input("marketplaceName", "市场名称（更新时留空表示全部）", operation === "marketplace.upgrade")}
      {operation === "memory.mode" && <label>{t("本会话记忆")}<select value={fields.enabled ?? "true"} onChange={e => setFields({ ...fields, enabled: e.target.value })}><option value="true">{t("启用")}</option><option value="false">{t("停用")}</option></select></label>}
      {operation === "memory.reset" && <p>{t("清除宿主机默认环境的原生记忆数据，影响使用此环境的其他会话；不是清空对话历史。")}</p>}
      {operation === "experiment.configure" && <><p>{t("修改原生用户配置中的 step_model_switching；主机空闲时才允许保存。重新连接 Codex 后生效，已有任务不会被中断。")}</p><label>{t("开关状态")}<select value={fields.enabled ?? "true"} onChange={e => setFields({ ...fields, enabled: e.target.value })}><option value="true">{t("启用")}</option><option value="false">{t("停用")}</option></select></label></>}
      {operation === "plugin.search" && input("searchTerm", "插件关键词")}
      {operation === "history.search" && input("searchTerm", "查找本会话用户消息和最终回复")}
      {operation === "turn.settings" && <><p>{t("仅修改本轮后续步骤，不改下一轮，不切换计划模式。宿主机必须已启用 step_model_switching；原生拒绝时不会假装成功。")}</p>{input("model", "模型名称（留空不改）", true)}{input("effort", "推理强度（留空不改）", true)}<label>{t("服务档位")}<select value={fields.serviceTier ?? ""} onChange={e => setFields({ ...fields, serviceTier: e.target.value })}><option value="">{t("保持不变")}</option><option value="clear">{t("清除档位")}</option><option value="fast">Fast</option><option value="flex">Flex</option></select></label><label>{t("推理摘要")}<select value={fields.summary ?? ""} onChange={e => setFields({ ...fields, summary: e.target.value })}><option value="">{t("保持不变")}</option>{["auto", "concise", "detailed", "none"].map(v => <option key={v} value={v}>{v}</option>)}</select></label>{!session?.activeTurnId && <p>{t("当前没有运行中的任务。")}</p>}</>}
      {operation === "nativeQueue.read" && <p>{t("这里显示宿主机原生队列，面板加入队列的任务仍在原来的队列中。")}</p>}
      {operation === "resetCards.read" && <p>{t("数量与卡片详情由当前原生账号上报，详情可能不完整。")}</p>}
      {operation === "resetCard.consume" && <>{input("creditId", "重置卡 ID（留空使用下一张可用卡）", true)}<p>{t("使用卡片后重新读取官方额度。这会消耗重置卡，与临时重置预测无关。")}</p></>}
      {operation === "goal.set" && <><p>{t("只保存暂停或完成目标，不自动执行。需要执行时请从输入框明确发送任务。")}</p>{input("objective", "目标内容（可留空保留原目标）", true)}<label>{t("目标状态")}<select value={fields.status ?? "paused"} onChange={e => setFields({ ...fields, status: e.target.value })}><option value="paused">{t("暂停")}</option><option value="complete">{t("完成")}</option></select></label><label>{t("Token 预算（留空保留原设置）")}<input type="number" min="1" max="9007199254740991" step="1" value={fields.tokenBudget ?? ""} onChange={e => setFields({ ...fields, tokenBudget: e.target.value })} /></label></>}
      {operation === "plugin.install" && <>{input("pluginName", "插件名称")}{input("remoteMarketplaceName", "插件市场名称")}</>}
      {operation === "plugin.uninstall" && input("pluginId", "已安装插件 ID")}
      {operation === "mcp.login" && input("name", "MCP 服务器名称")}
      {operation === "skill.toggle" && <>{input("name", "技能名称")}<label>{t("技能状态")}<select value={fields.enabled ?? "true"} onChange={e => setFields({ ...fields, enabled: e.target.value })}><option value="true">{t("启用")}</option><option value="false">{t("停用")}</option></select></label></>}
      {needsConfirmation(operation) && <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t("确认在此宿主机执行所选操作")}</label>}
      {!allowed && <p>{systemText(session?.actions?.manage?.message) || t(machine ? "请连接主机并更新连接服务后使用主机级管理。" : "请更新主机连接服务并接管此会话。")}</p>}
      <button type="submit" className="button button--quiet" disabled={!editable || needsConfirmation(operation) && !confirmed}>{busy || pending ? t("等待主机回执") : t(operations[operation])}</button>
    </form>
    {hostReceipt?.error && <p role="alert">{systemText(hostReceipt.error.message)}</p>}
    {receipt?.message ? <p role="alert">{systemText(receipt.message)}</p> : message && !result && <p role="status">{message}</p>}
    {result && <div aria-live="polite"><p>{t("宿主机返回")}: {t(statusLabel(result.status))}</p>{result.rows.length > 0 && <dl>{result.rows.map((row, index) => <div key={index}><dt>{systemText(row.name)}<small>{systemText(row.status)}</small></dt><dd>{row.detail}</dd></div>)}</dl>}{result.url && <a className="button button--quiet" href={result.url} target="_blank" rel="noopener noreferrer">{t("打开授权页面")}</a>}{result.nextCursor && <button className="button button--quiet" disabled={!editable} onClick={() => void run(result.nextCursor)}>{t("下一页")}</button>}{result.status === "unavailable" && <p>{t("当前账号未返回此项数据，无法据此计算用量。")}</p>}</div>}
  </div></details>;
}
