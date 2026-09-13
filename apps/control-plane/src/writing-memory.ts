import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { invariant } from "./errors.js";
import { newId, nowIso, sha256 } from "./crypto.js";

type Session = { project_id: string; next_session_seq: number };
type Learning = { user_id: string; workspace_id: string; enabled: number; scope: string; after_seq: number };
export type MemoryEntry = { id: string; phrase: string; replacement: string; scope: string; status: string; uses: number; source_session: string | null; source_event: string | null };

export function safeWritingText(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.trim().length >= 2 && value.length <= maximum
    && !/[\u0000-\u0008\u000b-\u001f]/.test(value)
    && !/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:api.?key|password|secret|token|密码|密钥)\s*[:=]|\b(?:sk|ghp|gho|xoxb)-[\w-]+|Bearer\s+|-----BEGIN|\b[A-Za-z0-9_+/=-]{32,}\b)/i.test(value);
}

/** Conservative lexical extraction, not a claim to understand arbitrary language. */
export function extractWritingCandidates(text: string): { phrase: string; replacement: string }[] {
  const clean = text.slice(0, 16000).replace(/```[\s\S]*?(?:```|$)/g, "");
  const found = new Map<string, { phrase: string; replacement: string }>();
  const add = (phrase: string, replacement: string) => {
    if (safeWritingText(phrase, 120) && safeWritingText(replacement, 300)) found.set(phrase.toLowerCase(), { phrase, replacement });
  };
  for (const line of clean.split(/\r?\n/)) {
    if (!safeWritingText(line, 1000)) continue;
    for (const match of line.matchAll(/[“"]([^”"\n]{2,100})[”"]\s*(?:可以称为|称为|叫做|也就是|means|is called|→|=>)\s*[“"]([^”"\n]{2,100})[”"]/gi)) add(match[1]!, match[2]!);
    for (const match of line.matchAll(/`([A-Za-z][A-Za-z0-9._+-]{2,39})`/g)) add(match[1]!, match[1]!);
  }
  return [...found.values()].slice(0, 12);
}

export class WritingMemory {
  constructor(private db: ControlPlaneDatabase) {}

  session(principal: Principal, sessionId: string): Session {
    const row = this.db.get<Session>("SELECT project_id,next_session_seq FROM logical_sessions WHERE workspace_id=? AND logical_session_id=? AND deleted_at IS NULL", principal.workspaceId, sessionId);
    invariant(row, 404, "SESSION_NOT_FOUND", "Session not found");
    return row;
  }

  read(principal: Principal, sessionId: string) {
    const session = this.session(principal, sessionId);
    const learning = this.db.get<Learning>("SELECT * FROM writing_learning WHERE user_id=? AND session_id=?", principal.userId, sessionId);
    const entries = this.db.all<MemoryEntry>(`SELECT id,phrase,replacement,scope,status,uses,source_session,source_event FROM writing_memory
      WHERE workspace_id=? AND user_id=? AND status!='deleted' AND (scope='personal' OR (scope='project' AND target_id=?))
      ORDER BY status,uses DESC,updated_at DESC LIMIT 500`, principal.workspaceId, principal.userId, session.project_id);
    return { enabled: learning ? learning.enabled === 1 : true, scope: learning?.scope ?? "project", entries };
  }

  configure(principal: Principal, sessionId: string, body: Record<string, unknown>) {
    const session = this.session(principal, sessionId);
    invariant(typeof body.enabled === "boolean" && ["project", "personal"].includes(String(body.scope)), 400, "INVALID_INPUT", "Invalid learning preferences");
    this.db.run(`INSERT INTO writing_learning(workspace_id,user_id,session_id,enabled,scope,after_seq) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,session_id) DO UPDATE SET enabled=excluded.enabled,scope=excluded.scope,after_seq=excluded.after_seq`,
      principal.workspaceId, principal.userId, sessionId, body.enabled ? 1 : 0, String(body.scope), session.next_session_seq - 1);
    return this.read(principal, sessionId);
  }

  save(principal: Principal, sessionId: string, body: Record<string, unknown>, id?: string) {
    const session = this.session(principal, sessionId);
    invariant(safeWritingText(body.phrase, 120) && safeWritingText(body.replacement, 500), 400, "INVALID_WRITING_TEXT", "Use short wording without credentials, addresses or URLs");
    invariant(body.scope === "personal" || body.scope === "project", 400, "INVALID_INPUT", "Invalid scope");
    const phrase = body.phrase.trim(); const replacement = body.replacement.trim();
    const target = body.scope === "project" ? session.project_id : principal.userId;
    const fingerprint = sha256(phrase.toLowerCase());
    if (id) {
      invariant(this.read(principal, sessionId).entries.some(entry => entry.id === id), 404, "MEMORY_NOT_FOUND", "Entry not found");
      const conflict = this.db.get<{id:string}>("SELECT id FROM writing_memory WHERE user_id=? AND scope=? AND target_id=? AND fingerprint=?", principal.userId, body.scope, target, fingerprint);
      invariant(!conflict || conflict.id === id, 409, "MEMORY_EXISTS", "This wording already exists in the selected scope");
      this.db.run("UPDATE writing_memory SET phrase=?,replacement=?,scope=?,target_id=?,fingerprint=?,status='active',updated_at=? WHERE id=? AND user_id=?", phrase, replacement, body.scope, target, fingerprint, nowIso(), id, principal.userId);
    } else {
      invariant(this.read(principal, sessionId).entries.length < 500, 409, "MEMORY_FULL", "Remove entries before adding more");
      this.db.run(`INSERT INTO writing_memory(id,workspace_id,user_id,scope,target_id,fingerprint,phrase,replacement,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?)
        ON CONFLICT(user_id,scope,target_id,fingerprint) DO UPDATE SET phrase=excluded.phrase,replacement=excluded.replacement,status='active',updated_at=excluded.updated_at`,
        newId("word"), principal.workspaceId, principal.userId, body.scope, target, fingerprint, phrase, replacement, nowIso(), nowIso());
    }
    return this.read(principal, sessionId);
  }

  remove(principal: Principal, sessionId: string, id: string) {
    invariant(this.read(principal, sessionId).entries.some(entry => entry.id === id), 404, "MEMORY_NOT_FOUND", "Entry not found");
    // Keep only a fingerprint to prevent automatically relearning a deleted entry.
    this.db.run("UPDATE writing_memory SET phrase='',replacement='',status='deleted',source_event=NULL,source_session=NULL,uses=0,updated_at=? WHERE id=? AND user_id=?", nowIso(), id, principal.userId);
    return this.read(principal, sessionId);
  }

  feedback(principal: Principal, sessionId: string, id: string) {
    invariant(this.read(principal, sessionId).entries.some(entry => entry.id === id && entry.status === "active"), 404, "MEMORY_NOT_FOUND", "Entry not found");
    this.db.run("UPDATE writing_memory SET uses=MIN(uses+1,10000),updated_at=? WHERE id=? AND user_id=?", nowIso(), id, principal.userId);
    return { ok: true };
  }

  /** Called only after durable ingress succeeds. No model calls on the event/ack path. */
  learnEvent(eventId: string) {
    const event = this.db.get<{ workspace_id: string; logical_session_id: string; project_id: string; session_seq: number; body_json: string }>(`SELECT e.*,b.body_json FROM durable_events e
      JOIN content_blobs b ON b.payload_ref=e.payload_ref JOIN projects p ON p.project_id=e.project_id
      WHERE e.event_id=? AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1`, eventId, nowIso());
    if (!event) return;
    const settings = this.db.all<Learning>(`SELECT u.user_id,u.workspace_id,COALESCE(l.enabled,1) AS enabled,COALESCE(l.scope,'project') AS scope,COALESCE(l.after_seq,0) AS after_seq
      FROM users u LEFT JOIN writing_learning l ON l.user_id=u.user_id AND l.session_id=?
      WHERE u.workspace_id=? AND COALESCE(l.enabled,1)=1 AND COALESCE(l.after_seq,0)<?`, event.logical_session_id, event.workspace_id, event.session_seq);
    if (!settings.length) return;
    let payload: { item?: { type?: string; text?: string; content?: {text?: string}[] } };
    try { payload = JSON.parse(event.body_json); } catch { return; }
    const item = payload?.item;
    if (!item || !["userMessage", "agentMessage"].includes(item.type ?? "")) return;
    const text = item.type === "userMessage" ? (Array.isArray(item.content) ? item.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "") : (typeof item.text === "string" ? item.text : "");
    const candidates = extractWritingCandidates(text);
    this.db.transaction(() => {
      for (const setting of settings) {
        const target = setting.scope === "project" ? event.project_id : setting.user_id;
        let count = this.db.get<{n:number}>("SELECT COUNT(*) AS n FROM writing_memory WHERE user_id=?", setting.user_id)!.n;
        for (const candidate of candidates) {
          if (count >= 500) break;
          const result = this.db.run(`INSERT OR IGNORE INTO writing_memory(id,workspace_id,user_id,scope,target_id,fingerprint,phrase,replacement,status,source_session,source_event,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'candidate',?,?,?,?)`,
            newId("word"), setting.workspace_id, setting.user_id, setting.scope, target, sha256(candidate.phrase.toLowerCase()), candidate.phrase, candidate.replacement, event.logical_session_id, eventId, nowIso(), nowIso());
          count += Number(result.changes);
        }
        this.db.run(`INSERT INTO writing_learning(workspace_id,user_id,session_id,enabled,scope,after_seq) VALUES(?,?,?,1,?,?)
          ON CONFLICT(user_id,session_id) DO UPDATE SET after_seq=excluded.after_seq`, setting.workspace_id, setting.user_id, event.logical_session_id, setting.scope, event.session_seq);
      }
    });
  }
}
