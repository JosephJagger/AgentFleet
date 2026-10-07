import { createHash } from "node:crypto";
import { AgentError } from "./errors.js";
import { sanitizeCodexResult, type CodexOperationRequest, type CodexOperationResult } from "./codex-operations.js";
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.map(obj) : [];
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Rpc = (method: string, params: Record<string, unknown> | null) => Promise<unknown>;
export async function hostCapabilityOperation(request: CodexOperationRequest, rpc: Rpc): Promise<CodexOperationResult | undefined> {
  const { operation, arguments: args } = request;
  if (operation === "bedrock.discover" || operation === "bedrock.setup") {
    const discovery = obj(await rpc("account/bedrock/discover", {}));
    if (operation === "bedrock.discover") return sanitizeCodexResult({ operation, status: "available", rows: list(discovery.profiles).map(profile => ({ name: String(profile.name), detail: String(profile.region ?? ""), status: "主机 AWS 配置；不包含密钥" })) })!;
    if (!list(discovery.profiles).some(profile => profile.name === args.profile)) throw new AgentError("CODEX_PROFILE_CHANGED", "AWS 配置不存在或已变化，请先重新读取");
    await rpc("account/bedrock/setup", { type: "profile", profile: args.profile, region: args.region });
    return { operation, status: "savedRequiresReconnect", rows: [] };
  }
  if (operation.startsWith("experiments.")) {
    const config = obj(await rpc("config/read", { includeLayers: true }));
    const user = list(config.layers).find(layer => obj(layer.name).type === "user" && !obj(layer.name).profile);
    const catalog = obj(await rpc("experimentalFeature/list", { limit: 40, ...(args.cursor ? { cursor: args.cursor } : {}) }));
    if (operation === "experiments.read") return sanitizeCodexResult({ operation, status: "available", rows: [
      { name: "version", detail: user?.version ?? "", status: "用户配置版本" },
      ...list(catalog.data).map(item => ({ name: item.name, detail: [item.displayName, item.description].filter(Boolean).join(" · "), status: `${item.stage}:${item.enabled === true ? "on" : "off"}` })),
    ], nextCursor: catalog.nextCursor })!;
    if (!user || user.version !== args.version) throw new AgentError("CODEX_CONFIG_CHANGED", "原生配置已变化，请重新读取后保存");
    // Walk the catalog rather than accepting arbitrary config keys from the browser.
    let page = catalog; let feature = list(page.data).find(item => item.name === args.name);
    for (let n = 0; !feature && typeof page.nextCursor === "string" && n < 10; n++) {
      page = obj(await rpc("experimentalFeature/list", { limit: 40, cursor: page.nextCursor })); feature = list(page.data).find(item => item.name === args.name);
    }
    if (!feature || !["beta", "stable"].includes(String(feature.stage))) throw new AgentError("CODEX_FEATURE_UNAVAILABLE", "此开关尚未开放用户配置，或已被原生移除");
    const result = obj(await rpc("config/value/write", { keyPath: `features.${args.name}`, value: args.enabled, mergeStrategy: "replace", expectedVersion: args.version }));
    return sanitizeCodexResult({ operation, status: result.status === "ok" ? "savedRequiresReconnect" : result.status, rows: [] })!;
  }
  if (operation === "migration.detect" || operation === "migration.import") {
    // Detection and import use the same native source and scope. Never accept client-supplied paths or migration payloads.
    const detection = obj(await rpc("externalAgentConfig/detect", { includeHome: true, cwds: [], maxSessions: 25, maxSessionAgeDays: 30 }));
    const items = list(detection.items).filter(item => typeof item.itemType === "string");
    if (operation === "migration.detect") return sanitizeCodexResult({ operation, status: "available", rows: items.slice(0, 40).map(item => ({ name: fingerprint(item), detail: String(item.description ?? item.itemType), status: String(item.itemType) })) })!;
    const selected = (args.itemIds as string[]).map(id => items.find(item => fingerprint(item) === id));
    if (selected.some(item => !item)) throw new AgentError("CODEX_IMPORT_CHANGED", "可导入内容已变化，请重新预览并选择");
    const result = obj(await rpc("externalAgentConfig/import", { migrationItems: selected, source: "agentfleets", providerId: "native-default" }));
    return sanitizeCodexResult({ operation, status: "started", rows: [{ name: String(result.importId ?? ""), detail: "导入已启动，请读取导入记录确认结果；不要重复提交", status: "等待原生完成" }] })!;
  }
  if (operation === "migration.history") {
    const history = obj(await rpc("externalAgentConfig/import/readHistories", {}));
    return sanitizeCodexResult({ operation, status: "available", rows: list(history.data).sort((a,b) => Number(b.completedAtMs) - Number(a.completedAtMs)).slice(0,40).map(item => ({ name: String(item.importId), detail: `成功 ${list(item.successes).length} · 失败 ${list(item.failures).length} · ${list(item.failures).map(f => `${f.itemType}: ${f.failureStage}`).join("; ")}`, status: Number.isFinite(Number(item.completedAtMs)) ? new Date(Number(item.completedAtMs)).toISOString() : "时间未上报" })) })!;
  }
  if (operation === "windows.setup") {
    if (process.platform !== "win32") return { operation, status: "notApplicable", rows: [] };
    const result = obj(await rpc("windowsSandbox/setupStart", { mode: args.mode }));
    return { operation, status: result.started === true ? "started" : "notStarted", rows: [{ name: "Windows 原生沙箱", detail: "安装可能要求在主机本地确认权限；完成后请重新检查沙箱状态", status: "启动不代表安装完成" }] };
  }
  return undefined;
}
