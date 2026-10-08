import { hostCapabilityOperation } from "./host-capability-operations.js";
import { AgentError } from "./errors.js";
import { parseCodexOperation, sanitizeCodexResult, type CodexOperationResult } from "./codex-operations.js";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export async function executeCodexOperation(value: unknown, threadId: string, mutationId: string, rpc: (method: string, params: Record<string, unknown> | null) => Promise<unknown>, refreshQuota: () => Promise<void>, activeTurnId?: string, cwd?: string): Promise<CodexOperationResult> {
  const { operation, arguments: args } = parseCodexOperation(value);
  const hostResult = await hostCapabilityOperation({ operation, arguments: args }, rpc);
  if (hostResult) return hostResult;
  let raw: Record<string, unknown>;
  if (operation === "skills.roots.save") {
    await rpc("skills/extraRoots/set", { extraRoots: args.roots });
    return { operation, status: "savedRequiresReconnect", rows: [] };
  }
  if (operation === "gateway.read" || operation === "remote.status") {
    raw = object(await rpc(operation === "gateway.read" ? "account/gatewayOAuth/read" : "remoteControl/status/read", null));
    const keys = operation === "gateway.read" ? ["providerName", "required", "status"] : ["status", "serverName"];
    return sanitizeCodexResult({ operation, status: "available", rows: keys.filter(k => k in raw).map(k => ({ name: k, detail: typeof raw[k] === "string" || typeof raw[k] === "boolean" ? String(raw[k]) : "未上报", status: "原生状态" })) })!;
  }
  if (operation === "voice.catalog") {
    raw = object(await rpc("thread/realtime/listVoices", {}));
    const voices = object(raw.voices);
    return sanitizeCodexResult({ operation, status: "available", rows: ["v1", "v2"].map(version => ({ name: version, detail: Array.isArray(voices[version]) ? voices[version].filter(v => typeof v === "string").join(", ") : "未上报", status: "原生目录；不代表当前 v3 通话的可用性验证" })) })!;
  }
  if (operation === "plugin.search") {
    raw = object(await rpc("plugin/search", { searchTerm: args.searchTerm, limit: 25, ...(args.cursor ? { cursor: args.cursor } : {}) }));
    const entries = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.plugins) ? raw.plugins : [];
    return sanitizeCodexResult({ operation, status: "available", rows: entries.map(object).map(item => { const plugin = object(item.plugin); const info = object(plugin.interface); return { name: String(info.displayName ?? plugin.name ?? plugin.id ?? "插件"), detail: `${String(info.shortDescription ?? "")} · ${String(plugin.name ?? "")} · ${String(item.marketplaceName ?? "")}`, status: plugin.installed ? "已安装" : String(plugin.availability ?? "原生搜索结果") }; }), nextCursor: raw.nextCursor })!;
  }
  if (operation === "history.turns") {
    raw = object(await rpc("thread/turns/list", { threadId, limit: 25, sortDirection: "desc", itemsView: "summary", ...(args.cursor ? { cursor: args.cursor } : {}) }));
    const rows = (Array.isArray(raw.data) ? raw.data : []).map(object).map(turn => {
      const message = (Array.isArray(turn.items) ? turn.items : []).map(object).find(item => item.type === "userMessage");
      const preview = (Array.isArray(message?.content) ? message.content : []).map(object).filter(item => item.type === "text").map(item => String(item.text ?? "")).join(" ");
      return { name: String(turn.id ?? ""), detail: preview || "原生任务", status: String(turn.status ?? "未上报") };
    });
    return sanitizeCodexResult({ operation, status: "available", rows, nextCursor: raw.nextCursor })!;
  }
  if (operation === "subagents.history") {
    const child = object(object(await rpc("thread/read", { threadId: args.threadId, includeTurns: false })).thread);
    if (child.parentThreadId !== threadId || !cwd || child.cwd !== cwd) throw new AgentError("CODEX_CHILD_CHANGED", "目标不属于当前项目会话的子代理");
    raw = object(await rpc("thread/turns/list", { threadId: args.threadId, limit: 10, sortDirection: "desc", itemsView: "full", ...(args.cursor ? { cursor: args.cursor } : {}) }));
    const rows = (Array.isArray(raw.data) ? raw.data : []).map(object).flatMap(turn => (Array.isArray(turn.items) ? turn.items : []).map(object).filter(item => ["userMessage", "agentMessage"].includes(String(item.type))).map(item => ({ name: item.type === "userMessage" ? "任务" : "回复", detail: typeof item.text === "string" ? item.text : (Array.isArray(item.content) ? item.content : []).map(object).filter(c => c.type === "text").map(c => c.text).join("\n"), status: String(turn.status ?? "") })));
    return sanitizeCodexResult({ operation, status: "available", rows, nextCursor: raw.nextCursor })!;
  }
  if (operation === "subagents.read") {
    raw = object(await rpc("thread/list", { limit: 100, sourceKinds: ["subAgent"], ...(cwd ? { cwd } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }));
    const children = (Array.isArray(raw.data) ? raw.data : []).map(object).filter(child => child.parentThreadId === threadId);
    return sanitizeCodexResult({ operation, status: "available", rows: children.slice(0, 49).map(child => ({ name: String(child.id), detail: [child.agentNickname ?? child.name, child.preview].filter(Boolean).join(" · "), status: String(object(child.status).type ?? "未上报") })), nextCursor: raw.nextCursor })!;
  }
  if (operation === "windows.readiness") {
    if (process.platform !== "win32") return { operation, status: "notApplicable", rows: [] };
    raw = object(await rpc("windowsSandbox/readiness", null));
    return sanitizeCodexResult({ operation, status: "available", rows: [{ name: "Windows 原生沙箱", detail: raw.status, status: "原生状态；未执行安装" }] })!;
  }
  if (operation === "workspaceMessages.read") {
    raw = object(await rpc("account/workspaceMessages/read", null));
    return sanitizeCodexResult({ operation, status: raw.featureEnabled ? "available" : "unavailable", rows: (Array.isArray(raw.messages) ? raw.messages : []).map(value => { const message = object(value); return { name: message.messageType, detail: message.messageBody, status: message.createdAt == null ? "发布时间未上报" : new Date(Number(message.createdAt) * 1000).toISOString() }; }) })!;
  }
  if (operation === "mcp.catalog") {
    raw = object(await rpc("mcpServerStatus/list", { threadId, limit: 10, detail: "full", ...(args.name ? { serverName: args.name } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }));
    const rows: CodexOperationResult["rows"] = [];
    for (const value of Array.isArray(raw.data) ? raw.data : []) {
      const server = object(value); const name = String(server.name ?? "");
      rows.push({ name, detail: String(server.runtimeStatus ?? "连接状态未上报"), status: String(server.authStatus ?? "未上报") });
      for (const [key, value] of Object.entries(object(server.tools))) { const tool = object(value); rows.push({ name: `${name} · ${key}`, detail: String(tool.description ?? ""), status: "MCP 工具" }); }
      for (const value of Array.isArray(server.resources) ? server.resources : []) { const resource = object(value); rows.push({ name: `${name} · ${String(resource.name ?? "资源")}`, detail: String(resource.uri ?? ""), status: "MCP 资源" }); }
      for (const value of Array.isArray(server.resourceTemplates) ? server.resourceTemplates : []) { const resource = object(value); rows.push({ name: `${name} · ${String(resource.name ?? "模板")}`, detail: String(resource.uriTemplate ?? ""), status: "MCP 资源模板" }); }
      if (server.toolsError != null) rows.push({ name, detail: "工具清单读取未完成；请检查主机配置", status: "结果不完整" });
    }
    if (rows.length > 49) { rows.splice(49); rows.push({ name: "结果过多", detail: "请指定 MCP 名称缩小范围", status: "仅显示前 49 项" }); }
    return sanitizeCodexResult({ operation, status: "available", rows, nextCursor: raw.nextCursor })!;
  }
  if (operation === "mcp.resource" || operation === "mcp.call") {
    const inventory = object(await rpc("mcpServerStatus/list", { threadId, serverName: args.name, limit: 1, detail: "full" }));
    const server = (Array.isArray(inventory.data) ? inventory.data : []).map(object).find(server => server.name === args.name);
    if (!server || (operation === "mcp.call" ? !Object.hasOwn(object(server.tools), String(args.tool)) : !(Array.isArray(server.resources) ? server.resources : []).some(resource => object(resource).uri === args.uri))) throw new AgentError("CODEX_TARGET_CHANGED", "所选工具或资源不在本会话原生 MCP 清单中，请重新读取");
    raw = object(await rpc(operation === "mcp.call" ? "mcpServer/tool/call" : "mcpServer/resource/read", operation === "mcp.call" ? { threadId, server: args.name, tool: args.tool, arguments: args.input } : { threadId, server: args.name, uri: args.uri }));
    const contents = operation === "mcp.call" ? raw.content : raw.contents;
    return sanitizeCodexResult({ operation, status: raw.isError === true ? "partialFailure" : "completed", rows: (Array.isArray(contents) ? contents : []).slice(0, 40).map(value => { const content = object(value); return { name: String(args.name), detail: typeof content.text === "string" ? content.text : "非文本内容未展开", status: operation === "mcp.call" ? "原生工具返回" : "原生资源返回" }; }) })!;
  }
  if (operation === "goal.read") {
    raw = object(await rpc("thread/goal/get", { threadId }));
    const goal = object(raw.goal);
    return sanitizeCodexResult({ operation, status: raw.goal == null ? "unavailable" : "available", rows: raw.goal == null ? [] : [{ name: "目标", detail: goal.objective, status: goal.status }, ...["tokenBudget", "tokensUsed", "timeUsedSeconds"].map(key => ({ name: key, detail: goal[key] == null ? "未设置" : String(goal[key]), status: "原生目标统计" }))] })!;
  }
  if (operation === "apps.installed" || operation === "apps.read") {
    raw = object(await rpc(operation === "apps.read" ? "app/read" : "app/installed", operation === "apps.read" ? { appIds: [args.appId], includeTools: true } : { forceRefresh: true }));
    const rows = (Array.isArray(raw.apps) ? raw.apps : []).map(value => { const app = object(value); return { name: String(app.name ?? app.runtimeName ?? app.id), detail: String(app.id ?? "") + (typeof app.description === "string" ? ` · ${app.description}` : ""), status: operation === "apps.read" ? "原生应用信息" : app.callable === true ? "可以调用" : app.enabled === true ? "已启用；暂不可调用" : "未启用" }; });
    if (operation === "apps.read") for (const value of Array.isArray(raw.apps) ? raw.apps : []) {
      for (const item of Array.isArray(object(value).toolSummaries) ? object(value).toolSummaries as unknown[] : []) { const tool = object(item); rows.push({ name: String(tool.title ?? tool.name ?? "工具"), detail: String(tool.description ?? ""), status: "应用工具说明" }); }
    }
    return sanitizeCodexResult({ operation, status: rows.length ? "available" : "unavailable", rows })!;
  }
  if (operation === "diagnostics.read") {
    raw = object(await rpc("server/diagnostics", {}));
    const process = object(raw.process);
    return sanitizeCodexResult({ operation, status: "available", rows: ["residentMemoryBytes", "physicalFootprintBytes"].filter(key => typeof process[key] === "number").map(key => ({ name: key, detail: String(process[key]), status: "当前原生进程" })).concat((Array.isArray(raw.gauges) ? raw.gauges : []).map(value => { const gauge = object(value); return { name: String(gauge.name ?? ""), detail: typeof gauge.value === "number" ? String(gauge.value) : "未上报", status: "原生诊断" }; })) })!;
  }
  if (operation.startsWith("section")) {
    if (operation === "sections.read") {
      raw = object(await rpc("threadSection/list", { limit: 25, ...(args.cursor ? { cursor: args.cursor } : {}) }));
      return sanitizeCodexResult({ operation, status: "available", rows: (Array.isArray(raw.data) ? raw.data : []).map(value => { const section = object(value); return { name: section.name, detail: section.id, status: "原生分组" }; }), nextCursor: raw.nextCursor })!;
    }
    const method = operation === "section.create" ? "threadSection/create" : operation === "section.rename" ? "threadSection/update" : operation === "section.delete" ? "threadSection/delete" : "thread/section/move";
    raw = object(await rpc(method, operation === "section.create" ? { name: args.name } : operation === "section.rename" ? { sectionId: args.sectionId, name: args.name } : operation === "section.delete" ? { sectionId: args.sectionId } : { threadId, sectionId: args.sectionId }));
    const section = object(raw.section);
    return sanitizeCodexResult({ operation, status: "completed", rows: section.id ? [{ name: section.name, detail: section.id, status: "原生分组" }] : [] })!;
  }
  if (operation === "attachment.note" || operation === "attachment.remove") {
    // This interface owns only its notes; uploaded file payloads and native internal attachments are never overwritten.
    await rpc(operation === "attachment.note" ? "thread/attachment/add" : "thread/attachment/remove", { threadId, attachmentType: "agentfleet.note", identityKey: args.identityKey, ...(operation === "attachment.note" ? { payload: { text: args.text } } : {}) });
    return { operation, status: "completed", rows: [{ name: "原生会话备注", detail: String(args.identityKey), status: "保存为会话元数据；不会自动作为下一轮输入" }] };
  }
  if (["nativeQueue.update", "nativeQueue.delete", "nativeQueue.reorder"].includes(operation)) {
    raw = object(await rpc("thread/queue/list", { threadId, limit: 100 }));
    const ids = (Array.isArray(raw.data) ? raw.data : []).map(value => object(value).id);
    if (operation === "nativeQueue.reorder" ? raw.nextCursor != null || !Array.isArray(args.submissionIds) || args.submissionIds.length !== ids.length || args.submissionIds.some(id => !ids.includes(id)) : !ids.includes(args.submissionId)) throw new AgentError("CODEX_TARGET_CHANGED", "原生队列已变化，请重新读取后操作");
    await rpc(operation === "nativeQueue.update" ? "thread/queue/update" : operation === "nativeQueue.delete" ? "thread/queue/delete" : "thread/queue/reorder", { threadId, ...(operation === "nativeQueue.reorder" ? { queuedSubmissionIds: args.submissionIds } : { queuedSubmissionId: args.submissionId }), ...(operation === "nativeQueue.update" ? { input: [{ type: "text", text: args.text }] } : {}) });
    return { operation, status: "completed", rows: [] };
  }
  if (operation === "account.read") {
    raw = object(await rpc("account/read", { refreshToken: false }));
    const account = object(raw.account);
    return sanitizeCodexResult({ operation, status: raw.account == null ? "notLoggedIn" : "loggedIn", rows: [{ name: "认证方式", detail: typeof account.type === "string" ? account.type : "未登录", status: typeof account.planType === "string" ? account.planType : "未上报" }] })!;
  }
  if (operation === "account.login") {
    raw = object(await rpc("account/login/start", { type: "chatgptDeviceCode" }));
    return sanitizeCodexResult({ operation, status: "awaitingAuthorization", rows: [{ name: "一次性登录码", detail: raw.userCode, status: "在官方授权页面输入" }, { name: "登录请求 ID", detail: raw.loginId, status: "可用于取消此次登录" }], url: raw.verificationUrl })!;
  }
  if (operation === "account.logout" || operation === "account.login.cancel") {
    await rpc(operation === "account.logout" ? "account/logout" : "account/login/cancel", operation === "account.logout" ? null : { loginId: args.loginId });
    await refreshQuota();
    return { operation, status: "completed", rows: [] };
  }
  if (operation === "usage.read") {
    raw = object(await rpc("account/usage/read", args.scope === "thread" ? { threadId } : {}));
    const rows: CodexOperationResult["rows"] = [];
    const summary = object(raw.summary);
    for (const [key, label] of Object.entries({ lifetimeTokens: "官方累计 tokens", currentStreakDays: "连续使用天数", longestStreakDays: "最长连续使用天数", peakDailyTokens: "单日最高 tokens", longestRunningTurnSec: "最长任务秒数" })) if (typeof summary[key] === "number") rows.push({ name: label, detail: String(summary[key]), status: "官方上报" });
    for (const day of Array.isArray(raw.dailyUsageBuckets) ? raw.dailyUsageBuckets.slice(-30).reverse() : []) {
      const d = object(day); if (typeof d.startDate === "string" && typeof d.tokens === "number") rows.push({ name: d.startDate, detail: `${d.tokens} tokens`, status: "每日用量" });
    }
    const usage = object(raw.threadUsage);
    if (typeof usage.estimatedUsageCreditsMicros === "number") rows.push({ name: "此会话估算点数", detail: String(usage.estimatedUsageCreditsMicros / 1_000_000), status: "官方估算" });
    for (const group of Array.isArray(usage.groups) ? usage.groups.slice(0, 10) : []) {
      const g = object(group); rows.push({ name: typeof g.model === "string" ? g.model : "模型未上报", detail: `输入 ${g.inputTokens ?? "未上报"} · 缓存 ${g.cachedInputTokens ?? "未上报"} · 输出 ${g.outputTokens ?? "未上报"}`, status: "此会话" });
    }
    return sanitizeCodexResult({ operation, status: rows.length ? "available" : "unavailable", rows })!;
  }
  if (operation === "plugin.catalog") {
    raw = object(await rpc("plugin/list", { forceRefetch: true, ...(cwd ? { cwds: [cwd] } : {}) }));
    const rows = (Array.isArray(raw.marketplaces) ? raw.marketplaces : []).flatMap(value => {
      const market = object(value);
      return (Array.isArray(market.plugins) ? market.plugins : []).map(value => { const plugin = object(value); return { name: String(plugin.name ?? ""), detail: String(market.name ?? ""), status: plugin.installed === true ? "已安装" : "可安装" }; });
    });
    const errors = Array.isArray(raw.marketplaceLoadErrors) ? raw.marketplaceLoadErrors.length : 0;
    if (errors) rows.push({ name: "部分插件来源读取失败", detail: String(errors), status: "结果不完整" });
    return sanitizeCodexResult({ operation, status: rows.length ? "available" : "unavailable", rows })!;
  }
  if (["memory.mode", "memory.reset", "plugin.reconcile", "marketplace.add", "marketplace.remove", "marketplace.upgrade"].includes(operation)) {
    if (operation === "memory.mode") await rpc("thread/memoryMode/set", { threadId, mode: args.enabled ? "enabled" : "disabled" });
    else if (operation === "memory.reset") await rpc("memory/reset", null);
    else if (operation === "plugin.reconcile") {
      raw = object(await rpc("plugin/reconcile", { reason: "user-requested-agentfleet-operation" }));
      const failures = Array.isArray(raw.failedRemotePluginIds) ? raw.failedRemotePluginIds.length : 0;
      return sanitizeCodexResult({ operation, status: failures ? "partialFailure" : "completed", rows: [{ name: "未完成的插件数", detail: String(failures), status: "原生同步结果" }] })!;
    } else {
      const method = operation === "marketplace.add" ? "marketplace/add" : operation === "marketplace.remove" ? "marketplace/remove" : "marketplace/upgrade";
      raw = object(await rpc(method, operation === "marketplace.add" ? { source: args.source } : args.marketplaceName ? { marketplaceName: args.marketplaceName } : {}));
      return sanitizeCodexResult({ operation, status: Array.isArray(raw.errors) && raw.errors.length ? "partialFailure" : "completed", rows: [{ name: "插件市场", detail: String(raw.marketplaceName ?? args.marketplaceName ?? "全部已配置市场"), status: raw.alreadyAdded === true ? "已存在；未重复添加" : "主机已完成" }] })!;
    }
    return { operation, status: "completed", rows: [] };
  }
  if (operation === "config.read" || operation === "config.save") {
    const current = object(await rpc("config/read", { includeLayers: true }));
    const config = object(current.config);
    const origins = object(current.origins);
    const user = (Array.isArray(current.layers) ? current.layers : []).map(object).find(layer => object(layer.name).type === "user" && !object(layer.name).profile);
    if (operation === "config.save") {
      if (!user || user.version !== args.version) throw new AgentError("CODEX_CONFIG_CHANGED", "原生配置已变化，请重新读取后保存");
      const saved = object(await rpc("config/batchWrite", { expectedVersion: args.version, edits: [
        { keyPath: "model_reasoning_summary", value: args.summary, mergeStrategy: "replace" },
        { keyPath: "model_verbosity", value: args.verbosity, mergeStrategy: "replace" },
      ], reloadUserConfig: false }));
      return sanitizeCodexResult({ operation, status: saved.status === "ok" ? "savedRequiresReconnect" : saved.status, rows: [] })!;
    }
    const keys = ["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "personality", "service_tier"];
    return sanitizeCodexResult({ operation, status: "available", rows: [
      { name: "version", detail: typeof user?.version === "string" ? user.version : "", status: "用户配置版本" },
      ...keys.map(key => ({ name: key, detail: typeof config[key] === "string" ? config[key] : "", status: String(object(object(origins[key]).name).type ?? "原生默认") })),
    ] })!;
  }
  if (operation === "config.requirements") {
    raw = object(await rpc("configRequirements/read", {}));
    const requirements = object(raw.requirements);
    const rows = ["allowRemoteControl", "allowLoginShell", "allowManagedHooksOnly", "allowedLoginMethods", "allowedApprovalPolicies", "allowedSandboxModes", "allowedWebSearchModes", "featureRequirements"].filter(key => key in requirements).map(key => ({ name: key, detail: JSON.stringify(requirements[key]), status: "原生管理策略；面板不绕过此限制" }));
    return sanitizeCodexResult({ operation, status: raw.requirements == null ? "notConfigured" : "available", rows })!;
  }
  if (operation === "experiment.configure") {
    const config = object(await rpc("config/read", { includeLayers: true }));
    const user = (Array.isArray(config.layers) ? config.layers : []).map(object).find(layer => object(layer.name).type === "user" && !object(layer.name).profile);
    if (!user || typeof user.version !== "string") throw new AgentError("CODEX_CONFIG_UNAVAILABLE", "无法获取原生用户配置版本，请先检查 Codex 配置");
    const saved = object(await rpc("config/value/write", { keyPath: "features.step_model_switching", value: args.enabled, mergeStrategy: "replace", expectedVersion: user.version }));
    return sanitizeCodexResult({ operation, status: saved.status === "ok" ? "savedRequiresReconnect" : saved.status, rows: [{ name: "step_model_switching", detail: args.enabled ? "启用" : "停用", status: "重新连接 Codex 后生效；不改变运行中任务" }] })!;
  }
  if (operation === "turn.settings") {
    if (!activeTurnId) throw new AgentError("NO_ACTIVE_TURN", "当前任务已结束，请刷新后调整下一轮设置");
    const { experimental: _experimental, confirmed: _confirmed, ...settings } = args;
    raw = object(await rpc("turn/settings/update", { threadId, turnId: activeTurnId, ...settings }));
    return sanitizeCodexResult({ operation, status: raw.status, rows: [{ name: "设置范围", detail: "仅本轮后续步骤；已开始的步骤、子会话和下一轮设置不受影响。不能切换计划模式。", status: "实验能力" }] })!;
  }
  if (operation === "provider.read") {
    raw = object(await rpc("modelProvider/capabilities/read", {}));
    return sanitizeCodexResult({ operation, status: "available", rows: ["imageGeneration", "namespaceTools", "webSearch"].map(key => ({ name: key, detail: typeof raw[key] === "boolean" ? raw[key] ? "支持" : "不支持" : "未上报", status: "当前模型提供方" })) })!;
  }
  if (operation === "memory.status") {
    raw = object(await rpc("memory/status", {}));
    return sanitizeCodexResult({ operation, status: "available", rows: [{ name: "记忆已就绪", detail: String(raw.v2Ready), status: "实验能力" }, { name: "已整合会话数", detail: String(raw.v2ConsolidatedThreads), status: "实验能力" }] })!;
  }
  if (["attachments.read", "history.search", "timeline.read", "nativeQueue.read"].includes(operation)) {
    const method = { "attachments.read": "thread/attachment/list", "history.search": "thread/searchOccurrences", "timeline.read": "thread/timeline/list", "nativeQueue.read": "thread/queue/list" }[operation as "attachments.read" | "history.search" | "timeline.read" | "nativeQueue.read"];
    raw = object(await rpc(method, { threadId, limit: 25, ...(args.cursor ? { cursor: args.cursor } : {}), ...(operation === "history.search" ? { searchTerm: args.searchTerm } : {}) }));
    const rows = (Array.isArray(raw.data) ? raw.data.slice(0, 25) : []).map(value => {
      const item = object(value);
      if (operation === "history.search") return { name: String(item.turnId ?? ""), detail: String(item.snippet ?? ""), status: String(item.itemId ?? "") };
      if (operation === "attachments.read") return { name: String(item.identityKey ?? item.id ?? ""), detail: String(item.attachmentType ?? "") + (item.attachmentType === "agentfleet.note" && typeof object(item.payload).text === "string" ? ` · ${String(object(item.payload).text)}` : ""), status: "原生持久附件；仅显示面板备注内容" };
      if (operation === "nativeQueue.read") return { name: String(item.id ?? ""), detail: (Array.isArray(item.input) ? item.input : []).map(input => object(input)).filter(input => input.type === "text").map(input => String(input.text ?? "")).join("\n"), status: "原生队列；与面板排队任务分开" };
      const nativeItem = object(item.item);
      return { name: String(item.turnId ?? item.turn_id ?? ""), detail: String(nativeItem.text ?? item.status ?? nativeItem.type ?? ""), status: String(item.type ?? "") };
    });
    return sanitizeCodexResult({ operation, status: "available", rows, ...(typeof raw.nextCursor === "string" ? { nextCursor: raw.nextCursor } : {}) })!;
  }
  if (operation === "resetCards.read") {
    raw = object(await rpc("account/rateLimits/read", null));
    const cards = object(raw.rateLimitResetCredits);
    const rows = [{ name: "可用重置卡", detail: typeof cards.availableCount === "number" ? String(cards.availableCount) : "未上报", status: Array.isArray(cards.credits) ? "详情已读取" : "详情未上报" }];
    for (const value of Array.isArray(cards.credits) ? cards.credits.slice(0, 30) : []) {
      const card = object(value);
      // Native expiresAt is Unix seconds; explicit null means non-expiring, absence is unknown.
      const expires = card.expiresAt;
      const date = typeof expires === "number" && Number.isSafeInteger(expires) ? new Date(expires * 1000) : null;
      const expiry = expires === null ? "不过期（原生注明）" : date && Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(".000Z", " UTC") : "未返回有效期";
      const status = ({available:"可用",redeeming:"使用中",redeemed:"已使用",unknown:"状态未知"} as Record<string,string>)[String(card.status)] ?? "状态未知";
      rows.push({ name: typeof card.title === "string" ? card.title : "重置卡", detail: `失效日期：${expiry}${typeof card.id === "string" ? `\n卡片 ID：${card.id}` : ""}`, status });
    }
    return sanitizeCodexResult({ operation, status: "available", rows })!;
  }
  if (operation === "resetCard.consume") {
    raw = object(await rpc("account/rateLimitResetCredit/consume", { idempotencyKey: mutationId, ...(args.creditId ? { creditId: args.creditId } : {}) }));
    await refreshQuota();
  } else if (operation === "goal.set") raw = object(await rpc("thread/goal/set", { threadId, ...args }));
  else if (operation === "goal.clear") raw = object(await rpc("thread/goal/clear", { threadId }));
  else if (operation === "plugin.install") {
    const catalog = object(await rpc("plugin/list", { forceRefetch: true, ...(cwd ? { cwds: [cwd] } : {}) }));
    const marketplace = (Array.isArray(catalog.marketplaces) ? catalog.marketplaces : []).map(object).find(item => item.name === args.remoteMarketplaceName);
    if (!marketplace || !(Array.isArray(marketplace.plugins) ? marketplace.plugins : []).some(value => object(value).name === args.pluginName)) throw new AgentError("CODEX_OPERATION_INVALID", "所选插件或市场未在原生清单中找到，请先刷新插件市场");
    raw = object(await rpc("plugin/install", { pluginName: args.pluginName, ...(typeof marketplace.path === "string" ? { marketplacePath: marketplace.path } : { remoteMarketplaceName: args.remoteMarketplaceName }), installAttemptId: mutationId }));
  }
  else if (operation === "plugin.uninstall") raw = object(await rpc("plugin/uninstall", { pluginId: args.pluginId }));
  else if (operation === "mcp.login") {
    raw = object(await rpc("mcpServer/oauth/login", { name: args.name, timeoutSecs: 120 }));
    return sanitizeCodexResult({ operation, status: "awaitingAuthorization", rows: [{ name: "MCP 服务器", detail: String(args.name), status: "完成官方授权后，重新读取 MCP 清单确认状态" }], url: raw.authorizationUrl })!;
  }
  else if (operation === "mcp.reload") raw = object(await rpc("config/mcpServer/reload", {}));
  else if (operation === "skill.toggle") raw = object(await rpc("skills/config/write", { name: args.name, enabled: args.enabled }));
  else throw new AgentError("CODEX_OPERATION_INVALID", "Operation requires its dedicated workspace handler");
  // Raw native config, credentials, and OAuth tokens never become cloud receipts.
  return sanitizeCodexResult({ operation, status: typeof raw.outcome === "string" ? raw.outcome : typeof raw.status === "string" ? raw.status : "completed", rows: [], ...(typeof raw.authorizationUrl === "string" ? { url: raw.authorizationUrl } : {}) })!;
}
