import { WritingPreferences } from "./writing-preferences.js";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { invariant } from "./errors.js";
import { newId, nowIso, sha256 } from "./crypto.js";

type Session = { project_id: string; next_session_seq: number };
type Learning = { user_id: string; workspace_id: string; enabled: number; scope: string; after_seq: number };
export type MemoryEntry = { id: string; phrase: string; replacement: string; scope: string; status: string; uses: number; source_session: string | null; source_event: string | null; source_role?: string | null };

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
    if (!safeWritingText(line, 1000) || /可能|也许|不要|不是|错误示例|\b(?:might|perhaps|incorrect|not)\b/i.test(line)) continue;
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
    this.cleanup();
    // Old pending entries are re-extracted from retained evidence, never require user review.
    for (const row of this.db.all<{id:string;phrase:string;replacement:string;body_json:string}>(`SELECT w.id,w.phrase,w.replacement,b.body_json FROM writing_memory w
      JOIN durable_events e ON e.event_id=w.source_event JOIN content_blobs b ON b.payload_ref=e.payload_ref
      WHERE w.user_id=? AND w.status='candidate' AND w.automatic=1`,principal.userId)) {
      let item; try { item=JSON.parse(row.body_json)?.item; } catch { continue; }
      const text=messageText(item);
      if (extractWritingCandidates(text).some(candidate=>candidate.phrase===row.phrase && candidate.replacement===row.replacement)) this.db.run("UPDATE writing_memory SET status='active' WHERE id=?",row.id);
      else this.db.run("DELETE FROM writing_memory WHERE id=?",row.id);
    }
    const entries = this.db.all<MemoryEntry>(`SELECT id,phrase,replacement,scope,status,uses,source_session,source_event FROM writing_memory
      WHERE workspace_id=? AND user_id=? AND status='active' AND (scope='personal' OR (scope='project' AND target_id=?))
      ORDER BY status,uses DESC,updated_at DESC LIMIT 500`, principal.workspaceId, principal.userId, session.project_id);
    for (const entry of entries) {
      const source = entry.source_event ? this.db.get<{body_json:string}>(`SELECT b.body_json FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref
        WHERE e.event_id=? AND e.workspace_id=? AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>?`, entry.source_event, principal.workspaceId, nowIso()) : undefined;
      try { const type = source ? JSON.parse(source.body_json)?.item?.type : null; entry.source_role = type === "userMessage" ? "user" : type === "agentMessage" ? "assistant" : null; }
      catch { entry.source_role = null; }
    }
    return { enabled: new WritingPreferences(this.db).effective(principal.userId,sessionId).effective.learning, scope: learning?.scope ?? "project", entries };
  }

  configure(principal: Principal, sessionId: string, body: Record<string, unknown>) {
    const session = this.session(principal, sessionId);
    invariant(typeof body.enabled === "boolean" && ["project", "personal"].includes(String(body.scope)), 400, "INVALID_INPUT", "Invalid learning preferences");
    this.db.run(`INSERT INTO writing_learning(workspace_id,user_id,session_id,enabled,scope,after_seq) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,session_id) DO UPDATE SET enabled=excluded.enabled,scope=excluded.scope,after_seq=excluded.after_seq`,
      principal.workspaceId, principal.userId, sessionId, body.enabled ? 1 : 0, String(body.scope), session.next_session_seq - 1);
    new WritingPreferences(this.db).save(principal,{settings:{learning:body.enabled}},sessionId);
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
      this.db.run("UPDATE writing_memory SET phrase=?,replacement=?,scope=?,target_id=?,fingerprint=?,status='active',automatic=0,source_question=NULL,updated_at=? WHERE id=? AND user_id=?", phrase, replacement, body.scope, target, fingerprint, nowIso(), id, principal.userId);
    } else {
      invariant(this.read(principal, sessionId).entries.length < 500, 409, "MEMORY_FULL", "Remove entries before adding more");
      this.db.run(`INSERT INTO writing_memory(id,workspace_id,user_id,scope,target_id,fingerprint,phrase,replacement,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?)
        ON CONFLICT(user_id,scope,target_id,fingerprint) DO UPDATE SET phrase=excluded.phrase,replacement=excluded.replacement,status='active',automatic=0,source_question=NULL,updated_at=excluded.updated_at`,
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

  cleanup() {
    this.db.run(`DELETE FROM writing_memory WHERE automatic=1 AND status IN ('candidate','active') AND (
      NOT EXISTS (SELECT 1 FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref JOIN projects p ON p.project_id=e.project_id JOIN logical_sessions s ON s.logical_session_id=e.logical_session_id
        WHERE e.event_id=writing_memory.source_event AND s.deleted_at IS NULL AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1)
      OR (source_question IS NOT NULL AND NOT EXISTS (SELECT 1 FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref
        WHERE e.event_id=writing_memory.source_question AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>?)))`,nowIso(),nowIso());
  }

  /** Called only after durable ingress succeeds. No model calls on the event/ack path. */
  learnEvent(eventId: string) {
    const event = this.db.get<{ workspace_id: string; logical_session_id: string; project_id: string; session_seq: number; body_json: string; execution_segment_id:string; native_thread_id:string|null; native_turn_id:string|null }>(`SELECT e.*,b.body_json FROM durable_events e
      JOIN content_blobs b ON b.payload_ref=e.payload_ref JOIN projects p ON p.project_id=e.project_id
      WHERE e.event_id=? AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1`, eventId, nowIso());
    if (!event) return;
    const settings = this.db.all<Learning>(`SELECT u.user_id,u.workspace_id,COALESCE(l.enabled,1) AS enabled,COALESCE(l.scope,'project') AS scope,COALESCE(l.after_seq,0) AS after_seq
      FROM users u LEFT JOIN writing_learning l ON l.user_id=u.user_id AND l.session_id=?
      WHERE u.workspace_id=? AND COALESCE(l.after_seq,0)<?`, event.logical_session_id, event.workspace_id, event.session_seq);
    if (!settings.length) return;
    let payload: { item?: { type?: string; text?: string; content?: {text?: string}[] } };
    try { payload = JSON.parse(event.body_json); } catch { return; }
    const item = payload?.item;
    if (!item || !["userMessage", "agentMessage"].includes(item.type ?? "")) return;
    const text = messageText(item);
    const candidates: {phrase:string;replacement:string;question?:string}[] = extractWritingCandidates(text);
    // Learn explicit professional rewrites only when linked to one actual user question.
    if(item.type === "agentMessage" && event.native_thread_id && event.native_turn_id) {
      const questions=this.db.all<{event_id:string;body_json:string}>(`SELECT e.event_id,b.body_json FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref
        WHERE e.workspace_id=? AND e.logical_session_id=? AND e.execution_segment_id=? AND e.native_thread_id=? AND e.native_turn_id=?
        AND e.type='item.completed' AND length(b.body_json)<=64000 AND e.session_seq<? AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>?
        ORDER BY e.session_seq DESC LIMIT 100`,event.workspace_id,event.logical_session_id,event.execution_segment_id,event.native_thread_id,event.native_turn_id,event.session_seq,nowIso())
        .flatMap(row=>{try {const value=JSON.parse(row.body_json)?.item;return value?.type==='userMessage' ? [{id:row.event_id,text:messageText(value)}] : [];}catch{return [];}});
      if(questions.length===1 && safeWritingText(questions[0]!.text,120) && !/[`{}\n]/.test(questions[0]!.text)) {
        const clean=text.slice(0,16000).replace(/```[\s\S]*?(?:```|$)/g,'');
        const rewrite=clean.split(/\r?\n/).filter(line=>safeWritingText(line,1000) && !/可能|也许|不要|不是|错误示例|\b(?:might|perhaps|incorrect|not)\b/i.test(line))
          .map(line=>/(?:可以表述为|可以描述为|建议表述为|专业表达[：:]|rewrite as|rephrase as)\s*[“"]([^”"\n]{4,250})[”"]/i.exec(line)).find(Boolean);
        if(rewrite && safeWritingText(rewrite[1],250) && !/可能|也许|不要|不是|\b(?:might|perhaps|not)\b/i.test(rewrite[0])) {
          const question=questions[0]!;
          const replacement=`${rewrite[1]}${/[\u3400-\u9fff]/.test(question.text) ? '：' : ': '}${question.text}`;
          candidates.push({phrase:question.text,replacement,question:question.id});
        }
      }
    }
    this.db.transaction(() => {
      for (const setting of settings) {
        const enabled=new WritingPreferences(this.db).effective(setting.user_id,event.logical_session_id).effective.learning;
        if(!enabled) {
          this.db.run(`INSERT INTO writing_learning(workspace_id,user_id,session_id,enabled,scope,after_seq) VALUES(?,?,?,0,?,?)
            ON CONFLICT(user_id,session_id) DO UPDATE SET after_seq=excluded.after_seq`,setting.workspace_id,setting.user_id,event.logical_session_id,setting.scope,event.session_seq);
          continue;
        }
        const target = setting.scope === "project" ? event.project_id : setting.user_id;
        let count = this.db.get<{n:number}>("SELECT COUNT(*) AS n FROM writing_memory WHERE user_id=?", setting.user_id)!.n;
        for (const candidate of candidates) {
          const existing=this.db.get<{id:string;replacement:string;automatic:number;status:string}>("SELECT id,replacement,automatic,status FROM writing_memory WHERE user_id=? AND scope=? AND target_id=? AND fingerprint=?",setting.user_id,setting.scope,target,sha256(candidate.phrase.toLowerCase()));
          if(existing) {
            if(existing.automatic===1 && existing.status==='active' && existing.replacement===candidate.replacement) this.db.run("UPDATE writing_memory SET source_event=?,source_question=?,source_session=?,updated_at=? WHERE id=?",eventId,candidate.question??null,event.logical_session_id,nowIso(),existing.id);
            continue;
          }
          if (count >= 500) {
            const evicted=this.db.run("DELETE FROM writing_memory WHERE id=(SELECT id FROM writing_memory WHERE user_id=? AND automatic=1 AND status='active' ORDER BY uses,updated_at LIMIT 1)",setting.user_id);
            count-=Number(evicted.changes);
            if(count>=500) break;
          }
          const result = this.db.run(`INSERT OR IGNORE INTO writing_memory(id,workspace_id,user_id,scope,target_id,fingerprint,phrase,replacement,status,automatic,source_session,source_event,source_question,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'active',1,?,?,?,?,?)`,
            newId("word"), setting.workspace_id, setting.user_id, setting.scope, target, sha256(candidate.phrase.toLowerCase()), candidate.phrase, candidate.replacement, event.logical_session_id, eventId, candidate.question ?? null, nowIso(), nowIso());
          count += Number(result.changes);
        }
        this.db.run(`INSERT INTO writing_learning(workspace_id,user_id,session_id,enabled,scope,after_seq) VALUES(?,?,?,1,?,?)
          ON CONFLICT(user_id,session_id) DO UPDATE SET after_seq=excluded.after_seq`, setting.workspace_id, setting.user_id, event.logical_session_id, setting.scope, event.session_seq);
      }
    });
  }
}

function messageText(item: {type?:string;text?:unknown;content?:{text?:unknown}[]} | undefined): string {
  return item?.type === "userMessage" ? (Array.isArray(item.content) ? item.content.map(part=>typeof part?.text==='string'?part.text:'').join('\n') : '') : typeof item?.text==='string' ? item.text : '';
}
