import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { WritingMemory } from "./writing-memory.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

type Event = { event_id: string; execution_segment_id: string; native_thread_id: string | null; native_turn_id: string | null; native_item_id: string | null; type: string; body_json: string; session_seq: number; payload_size: number };
export type WritingInteraction = { id: string; paired: boolean; state: string; feedback: string | null; messages: { eventId: string; role: "user" | "assistant"; text: string; truncated: boolean }[] };

/** A view over retained source events. No duplicate transcript or inferred authorship. */
export class WritingHistory {
  constructor(private db: ControlPlaneDatabase, private memory: WritingMemory) {}
  read(principal: Principal, sessionId: string) {
    this.memory.session(principal, sessionId);
    const rows = this.db.all<Event>(`SELECT e.event_id,e.execution_segment_id,e.native_thread_id,e.native_turn_id,e.native_item_id,e.type,e.session_seq,length(b.body_json) AS payload_size,CASE WHEN length(b.body_json)<=64000 THEN b.body_json ELSE '{}' END AS body_json
      FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref JOIN projects p ON p.project_id=e.project_id
      WHERE e.workspace_id=? AND e.logical_session_id=? AND p.sync_content=1 AND e.payload_state='present'
      AND b.deleted_at IS NULL AND b.expires_at>? AND e.type IN ('item.completed','turn.completed','turn.failed','turn.interrupted')
      ORDER BY e.session_seq DESC LIMIT 501`, principal.workspaceId, sessionId, nowIso());
    const truncated = rows.length > 500 || rows.some(row => row.payload_size > 64000);
    const groups = new Map<string, WritingInteraction>();
    const seenItems = new Set<string>();
    for (const row of rows.slice(0, 500).reverse()) {
      const paired = !!row.native_thread_id && !!row.native_turn_id;
      const key = paired ? JSON.stringify([row.execution_segment_id,row.native_thread_id,row.native_turn_id]) : row.event_id;
      const group = groups.get(key) ?? { id: row.event_id, paired, state: "unknown", feedback: null, messages: [] };
      groups.set(key, group);
      if (row.type !== "item.completed") { group.state = row.type.slice(5); continue; }
      let payload;
      try { payload = JSON.parse(row.body_json); } catch { continue; }
      const item = payload?.item;
      if (!item || !["userMessage","agentMessage"].includes(item.type)) continue;
      const itemKey = row.native_item_id ? JSON.stringify([key,row.native_item_id]) : row.event_id;
      if (seenItems.has(itemKey)) continue;
      seenItems.add(itemKey);
      const text = item.type === "userMessage" ? (Array.isArray(item.content) ? item.content.map((part: {text?:unknown}) => typeof part?.text === "string" ? part.text : "").join("\n") : "") : typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;
      if (!group.messages.length) group.id = row.event_id;
      group.messages.push({ eventId: row.event_id, role: item.type === "userMessage" ? "user" : "assistant", text: text.slice(0, 2000), truncated: text.length > 2000 });
    }
    const feedback = new Map(this.db.all<{source_event:string;rating:string}>("SELECT source_event,rating FROM writing_history_feedback WHERE user_id=? AND session_id=?", principal.userId, sessionId).map(row => [row.source_event,row.rating]));
    const interactions = [...groups.values()].filter(group => group.messages.length).reverse().slice(0, 30);
    for (const group of interactions) {
      group.paired = group.paired && group.messages.some(message => message.role === "user") && group.messages.some(message => message.role === "assistant");
      group.feedback = feedback.get(group.id) ?? null;
    }
    return { interactions, truncated: truncated || groups.size > 30 };
  }
  feedback(principal: Principal, sessionId: string, eventId: string, rating: unknown) {
    invariant(["useful", "unhelpful", "clear"].includes(String(rating)), 400, "INVALID_INPUT", "Invalid history feedback");
    const interaction = this.read(principal, sessionId).interactions.find(item => item.id === eventId);
    invariant(interaction?.paired, 404, "INTERACTION_NOT_FOUND", "Paired interaction not found");
    if (rating === "clear") this.db.run("DELETE FROM writing_history_feedback WHERE user_id=? AND source_event=?", principal.userId, eventId);
    else this.db.run(`INSERT INTO writing_history_feedback(user_id,session_id,source_event,rating,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,source_event) DO UPDATE SET rating=excluded.rating,updated_at=excluded.updated_at`, principal.userId, sessionId, eventId, String(rating), nowIso());
    return this.read(principal, sessionId);
  }
}
