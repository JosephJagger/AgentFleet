import { isRecord, redact } from "./util.js";
import type { AppEvent } from "./app-server.js";
/** Whitelist status metadata; hook commands, outputs, paths and authentication errors stay local. */
export function codexNotification(method: string, params: Record<string, unknown>): AppEvent | null {
  if (typeof params.threadId !== "string") return null;
  const base = { nativeThreadId: params.threadId, ...(typeof params.turnId === "string" ? { nativeTurnId: params.turnId } : {}) };
  const text = (value: unknown) => typeof value === "string" ? redact(value).slice(0, 1000) : "未上报";
  if (method === "model/rerouted") return { ...base, type: "codex.model_rerouted", payload: { message: `${text(params.fromModel)} → ${text(params.toModel)} · ${text(params.reason)}` } };
  if (method === "item/mcpToolCall/progress" && typeof params.itemId === "string") return { ...base, nativeItemId: params.itemId, type: "codex.mcp_progress", payload: { message: text(params.message) } };
  if (["hook/started", "hook/completed"].includes(method) && isRecord(params.run) && typeof params.run.id === "string") return { ...base, nativeItemId: params.run.id, type: "codex.hook_status", payload: { message: `${text(params.run.eventName)} · ${text(params.run.handlerType)} · ${text(params.run.status)}` } };
  if (["modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted"].includes(method)) return { ...base, type: "codex.auth_recovery", payload: { message: `${text(params.provider)} · ${method.endsWith("Started") ? "正在恢复认证" : "认证恢复流程已结束"}` } };
  if (method === "mcpServer/oauthLogin/completed") return { ...base, type: "codex.mcp_auth", payload: { message: `${text(params.name)} · ${params.success === true ? "授权已完成" : "授权未完成，请检查宿主机配置"}` } };
  if (method === "mcpServer/startupStatus/updated") return { ...base, type: "codex.mcp_status", payload: { message: `${text(params.name)} · ${text(params.status)}` } };
  return null;
}
