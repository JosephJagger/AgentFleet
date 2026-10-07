import { invariant } from "./errors.js";

export interface HostMaintenance { operationId: string; startedAt: string; }
export function parseMaintenance(input: unknown): HostMaintenance | null {
  if (input === null || input === undefined) return null;
  invariant(typeof input === "object" && !Array.isArray(input),400,"INVALID_MAINTENANCE","Invalid maintenance report");
  const value=input as Record<string,unknown>;
  invariant(typeof value.operationId === "string" && value.operationId.length > 0 && value.operationId.length <= 200 &&
    typeof value.startedAt === "string" && value.startedAt.length <= 64 && Number.isFinite(Date.parse(value.startedAt)),
    400,"INVALID_MAINTENANCE","Invalid maintenance report");
  return {operationId:value.operationId,startedAt:value.startedAt};
}

// Match the Agent's drain gate: reading, cancellation and approvals remain available.
export const DRAIN_BLOCKED_COMMANDS: readonly string[] = ["thread.claim", "thread.rename", "thread.archive", "thread.unarchive", "thread.fork", "thread.delete.preview", "thread.delete", "turn.start", "turn.compact", "turn.review", "turn.queue", "turn.steer", "codex.manage"];
export const MAINTENANCE_MESSAGE = "主机正在维护，等待安全重启；当前任务可继续，暂不接受新任务";
export function blocksDuringMaintenance(report: string | null, command: string): boolean {
  return Boolean(report && report !== "null" && DRAIN_BLOCKED_COMMANDS.includes(command));
}
