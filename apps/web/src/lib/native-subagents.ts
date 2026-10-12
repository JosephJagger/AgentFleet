export interface NativeSubagent {
  id: string;
  title: string;
  status: string;
  description?: string;
}

export interface NativeSubagentMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  status?: string;
  truncated?: boolean;
  textOffset?: number;
  textLength?: number;
}

export interface NativeSubagentSnapshot {
  provider: "codex" | "claude";
  items: NativeSubagent[];
  messages?: NativeSubagentMessage[];
  childId?: string;
  nextCursor?: string | null;
}

export function nativeSubagentRunning(status: string): boolean {
  return ["running", "in_progress", "active"].includes(status);
}

export function nativeSubagentStatus(status: string): string {
  if (nativeSubagentRunning(status)) return "执行中";
  return ({ completed: "已完成", failed: "失败", interrupted: "已停止", stopped: "已停止", killed: "已停止", cancelled: "已取消", waiting: "等待中", pending: "等待中", idle: "空闲", closed: "已结束" } as Record<string, string>)[status] ?? "状态待确认";
}
