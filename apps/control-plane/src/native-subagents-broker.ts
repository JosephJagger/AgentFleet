import { randomUUID } from "node:crypto";
import { AppError, invariant } from "./errors.js";
import type { HistoryBinding } from "./session-history.js";

export interface SubagentsEndpoint {
  key: object; generation: number; producerEpoch: string; appServerEpoch: string;
  ready: boolean; supported: boolean; send: (value: Record<string, unknown>) => boolean;
}
export interface SubagentsRead { childId?: string; cursor?: string | null }
type Reply = { requestId: string; result?: unknown; error?: { code?: string; message?: string } };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const bounded = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit;
const optionalString = (value: unknown, limit: number) => value === undefined || bounded(value, limit);
const offset = (value: unknown) => value === undefined || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validResult(value: unknown, childId?: string): value is Record<string, unknown> {
  if (!object(value) || !only(value, ["provider", "items", "messages", "childId", "nextCursor"]) || !["codex", "claude"].includes(String(value.provider)) || value.childId !== childId || !(value.nextCursor === null || bounded(value.nextCursor, 12000)) || Buffer.byteLength(JSON.stringify(value), "utf8") > 900000) return false;
  if (!Array.isArray(value.items) || value.items.length > 200 || !value.items.every(item => object(item) && only(item, ["id", "title", "status", "description"]) && bounded(item.id, 256) && bounded(item.title, 500) && bounded(item.status, 100) && optionalString(item.description, 10000))) return false;
  return value.messages === undefined || Array.isArray(value.messages) && value.messages.length <= 100 && value.messages.every(item => object(item) && only(item, ["id", "role", "text", "status", "truncated", "textOffset", "textLength"]) && ["user", "assistant"].includes(String(item.role)) && bounded(item.text, 20000) && optionalString(item.id, 256) && optionalString(item.status, 100) && (item.truncated === undefined || typeof item.truncated === "boolean") && offset(item.textOffset) && offset(item.textLength) && (item.textOffset === undefined || item.textLength === undefined || Number(item.textOffset) <= Number(item.textLength)));
}

/** Passive native reads. No persisted command, task creation, retry, or child takeover. */
export class NativeSubagentsBroker {
  private pending = new Map<string, { machineId: string; endpoint: SubagentsEndpoint; input: SubagentsRead; finish: (error: AppError | null, result?: Record<string, unknown>) => void }>();
  constructor(private endpoint: (machineId: string) => SubagentsEndpoint | undefined, private timeoutMs = 20000) {}
  read(binding: HistoryBinding, input: SubagentsRead): Promise<Record<string, unknown>> {
    const endpoint = this.endpoint(binding.machineId);
    invariant(endpoint?.ready, 409, "SUBAGENTS_HOST_OFFLINE", "主机正在同步连接，请稍后读取");
    invariant(endpoint.supported, 409, "SUBAGENTS_UNSUPPORTED", "请更新主机连接服务，以查看原生子 Agent");
    invariant([...this.pending.values()].filter(p => p.machineId === binding.machineId).length < 8, 429, "SUBAGENTS_BUSY", "读取繁忙，请稍后重试");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => finish(new AppError(504, "SUBAGENTS_TIMEOUT", "原生子 Agent 读取超时")), this.timeoutMs);
      const finish = (error: AppError | null, result?: Record<string, unknown>) => {
        clearTimeout(timer); this.pending.delete(requestId);
        if (error) reject(error); else resolve(result!);
      };
      this.pending.set(requestId, { machineId: binding.machineId, endpoint, input, finish });
      try {
        if (!endpoint.send({ type: "subagents.read", requestId, logicalSessionId: binding.sessionId, projectExternalId: binding.projectExternalId, nativeThreadId: binding.nativeThreadId, executionSegmentId: binding.executionSegmentId, contentEpoch: binding.contentEpoch, transportGeneration: endpoint.generation, producerEpoch: endpoint.producerEpoch, appServerEpoch: endpoint.appServerEpoch, ...input })) finish(new AppError(409, "SUBAGENTS_HOST_OFFLINE", "主机连接已断开"));
      } catch { finish(new AppError(409, "SUBAGENTS_HOST_OFFLINE", "主机连接已断开")); }
    });
  }
  receive(machineId: string, key: object, message: Reply): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.machineId !== machineId || pending.endpoint.key !== key) return;
    const current = this.endpoint(machineId);
    // Routine registry reconciliation can change ready without changing identity.
    if (!current || current.key !== key || current.generation !== pending.endpoint.generation || current.producerEpoch !== pending.endpoint.producerEpoch || current.appServerEpoch !== pending.endpoint.appServerEpoch) {
      pending.finish(new AppError(409, "SUBAGENTS_TARGET_CHANGED", "主机连接已变化，请重新读取")); return;
    }
    if (message.error) {
      const code = typeof message.error.code === "string" && message.error.code.length <= 100 && /^SUBAGENTS_[A-Z_]+$/.test(message.error.code) ? message.error.code! : "SUBAGENTS_READ_FAILED";
      const reason = code === "SUBAGENTS_UNSUPPORTED" ? "请更新主机连接服务，以查看原生子 Agent" : code === "SUBAGENTS_CONTENT_DISABLED" ? "项目未开启内容同步" : "原生子 Agent 暂时无法读取，请稍后重试";
      pending.finish(new AppError(409, code, reason)); return;
    }
    const result = message.result;
    if (!validResult(result, pending.input.childId)) {
      pending.finish(new AppError(502, "SUBAGENTS_INVALID", "主机返回的子 Agent 信息无效")); return;
    }
    pending.finish(null, result);
  }
  disconnect(machineId: string, key: object): void {
    for (const pending of this.pending.values()) if (pending.machineId === machineId && pending.endpoint.key === key) pending.finish(new AppError(409, "SUBAGENTS_HOST_OFFLINE", "读取期间主机断开连接"));
  }
  close(): void {
    for (const pending of this.pending.values()) pending.finish(new AppError(503, "SUBAGENTS_UNAVAILABLE", "服务正在关闭，请稍后重试"));
  }
}
