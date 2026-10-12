import { AgentError } from "./errors.js";
import { readConversation } from "./conversation-history.js";
import { isRecord } from "./util.js";

export interface NativeSubagent { id: string; title: string; status: string; description?: string; }
export interface NativeSubagentMessage { id?: string; role: "user" | "assistant"; text: string; status?: string; truncated?: boolean; textOffset?: number; textLength?: number; }
export interface NativeSubagentsPage { provider: "codex" | "claude"; items: NativeSubagent[]; messages?: NativeSubagentMessage[]; childId?: string; nextCursor: string | null; }
// Native application context is sticky. Clear the retired panel guidance even
// when a queued request from an older client still carries the legacy flag.
export const nativeCollaborationContext = (_legacyEnabled?: boolean) => ({ additionalContext: {} });
type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const record = (value: unknown) => { if (!isRecord(value)) throw new AgentError("SUBAGENTS_INVALID", "原生分工数据无效"); return value; };

export function validateSubagentRequest(childId?: string, cursor?: string | null): void {
  if (childId !== undefined && (!childId || childId.length > 256 || /[\0\r\n]/.test(childId))) throw new AgentError("SUBAGENTS_INPUT", "子 Agent 标识无效");
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !cursor || cursor.length > 12000)) throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效");
}

/** Passive catalog reads only. Neither the parent nor a child is resumed or acquired. */
export async function readCodexSubagents(rpc: Rpc, parentId: string, cwd: string, childId?: string, cursor: string | null = null): Promise<NativeSubagentsPage> {
  validateSubagentRequest(childId, cursor);
  const parent = record(record(await rpc("thread/read", { threadId: parentId, includeTurns: false })).thread);
  if (parent.id !== parentId || parent.cwd !== cwd) throw new AgentError("SUBAGENTS_TARGET_CHANGED", "主会话项目已变化，请重新读取");
  if (childId) {
    const child = record(record(await rpc("thread/read", { threadId: childId, includeTurns: false })).thread);
    if (child.id !== childId || child.parentThreadId !== parentId || child.cwd !== cwd) throw new AgentError("SUBAGENTS_TARGET_CHANGED", "目标不属于当前项目主会话的子 Agent");
    const page = await readConversation(rpc, childId, cursor);
    if (page.nativeThreadId !== childId || page.cwd !== cwd) throw new AgentError("SUBAGENTS_TARGET_CHANGED", "子 Agent 项目已变化");
    return { provider: "codex", items: [], childId, messages: page.items.map(item => ({ id: item.id, role: item.role, text: item.text, status: page.turnStatus ?? "unknown", truncated: item.truncated, textOffset: item.textOffset, textLength: item.textLength })), nextCursor: page.nextCursor };
  }
  let position: { archived: boolean; cursor: string | null } = { archived: false, cursor: null };
  if (cursor) {
    try { position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效"); }
    if (!isRecord(position) || typeof position.archived !== "boolean" || (position.cursor !== null && (typeof position.cursor !== "string" || !position.cursor || position.cursor.length > 8192))) throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效");
  }
  // Filter in native storage before pagination: unrelated parents cannot fill
  // the first page and conceal this parent's children.
  const page = record(await rpc("thread/list", { parentThreadId: parentId, cwd, sourceKinds: ["subAgentThreadSpawn"], limit: 25, archived: position.archived, cursor: position.cursor, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true }));
  if (!Array.isArray(page.data) || page.data.length > 25 || (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 8192 || page.nextCursor === position.cursor))) throw new AgentError("SUBAGENTS_INVALID", "原生分工分页无效");
  const items = await Promise.all(page.data.map(record).filter(child => child.parentThreadId === parentId && child.cwd === cwd && typeof child.id === "string").map(async child => {
    let status = isRecord(child.status) && typeof child.status.type === "string" ? child.status.type.slice(0, 60) : "unknown";
    // A passive connection cannot see another process's loaded state. Only a
    // persisted terminal outcome can upgrade notLoaded/idle to completed, etc.
    if (["notLoaded", "idle"].includes(status) && child.historyMode === "paginated") {
      try {
        const turns = record(await rpc("thread/turns/list", { threadId: child.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));
        const last = Array.isArray(turns.data) && turns.data.length === 1 ? record(turns.data[0]) : undefined;
        if (last && ["completed", "failed", "interrupted"].includes(String(last.status))) status = String(last.status);
      } catch { /* State remains explicitly unknown/idle if persisted evidence is unavailable. */ }
    }
    return { id: String(child.id).slice(0, 256), title: String(child.agentNickname || child.name || `子 Agent ${String(child.id).slice(0, 8)}`).slice(0, 200), status, ...(typeof child.preview === "string" ? { description: child.preview.slice(0, 2000) } : {}) };
  }));
  const next = typeof page.nextCursor === "string" ? { archived: position.archived, cursor: page.nextCursor } : !position.archived ? { archived: true, cursor: null } : null;
  return { provider: "codex", items, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
}
