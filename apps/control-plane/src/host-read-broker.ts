import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export interface HostEndpoint { key: object; ready: boolean; supported: boolean; send: (value: Record<string, unknown>) => boolean }

/** One request frame to one host connection, answered by a result frame from that same connection. */
export class HostReadBroker {
  private pending = new Map<string, { machineId: string; key: object; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly frame: string, private readonly codePrefix: string, private readonly endpoint: (machineId: string) => HostEndpoint | undefined, private readonly unsupported: string) {}

  request(machineId: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const endpoint = this.endpoint(machineId);
    if (!endpoint?.ready) return Promise.reject(new AppError(409, `${this.codePrefix}HOST_OFFLINE`, "主机离线或正在同步"));
    if (!endpoint.supported) return Promise.reject(new AppError(409, `${this.codePrefix}UNSUPPORTED`, this.unsupported));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new AppError(504, `${this.codePrefix}TIMEOUT`, "主机响应超时")); }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { machineId, key: endpoint.key, resolve, reject, timer });
      if (!endpoint.send({ type: this.frame, requestId, ...payload })) { clearTimeout(timer); this.pending.delete(requestId); reject(new AppError(409, `${this.codePrefix}HOST_OFFLINE`, "主机连接已断开")); }
    });
  }

  receive(machineId: string, key: object, message: Record<string, unknown>) {
    const pending = typeof message.requestId === "string" ? this.pending.get(message.requestId) : undefined;
    if (!pending || pending.machineId !== machineId || pending.key !== key) return;
    clearTimeout(pending.timer); this.pending.delete(message.requestId as string);
    if (message.error && typeof message.error === "object") {
      const error = message.error as Record<string, unknown>;
      const code = typeof error.code === "string" && error.code.startsWith(this.codePrefix) && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : `${this.codePrefix}HOST_FAILED`;
      pending.reject(new AppError(409, code, typeof error.message === "string" ? error.message.slice(0, 500) : "主机执行失败"));
    } else pending.resolve(message.result);
  }

  disconnect(machineId: string, key: object) {
    for (const [id, pending] of this.pending) if (pending.machineId === machineId && pending.key === key) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new AppError(409, `${this.codePrefix}HOST_OFFLINE`, "主机连接已断开"));
    }
  }

  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError(503, `${this.codePrefix}HOST_OFFLINE`, "服务正在关闭")); }
    this.pending.clear();
  }
}
