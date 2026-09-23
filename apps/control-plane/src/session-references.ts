import { randomUUID } from "node:crypto";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { CoordinationService } from "./coordination.js";
import { AppError, invariant } from "./errors.js";
import type { WritingAI } from "./writing-ai.js";

type Identity = { id: string; host: string; project: string; title: string; link: string; version: string; incomplete: boolean };
type Job = { id: string; owner: string; workspace: string; sourceId: string; state: "reading" | "summarizing" | "combining" | "ready" | "failed"; done: number; total: number; identity: Identity; summary?: string; error?: string; controller: AbortController; createdAt: number };
const CHUNK_CHARS = 40_000;

// A cross-session handoff needs the conversation, not megabytes of transient
// shell output or private reasoning summaries. The source link remains available
// for inspecting those records in their original context.
function conversationText(event: Record<string, unknown>): string | undefined {
  if (event.payloadState !== "present") return;
  const payload = event.payload as Record<string, unknown> | undefined;
  const item = payload?.item as Record<string, unknown> | undefined;
  if (!item) return;
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const body = item.content.map(part => typeof part === "object" && part && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, string>).text : "").filter(Boolean).join("\n").trim();
    return body ? `User: ${body}\n\n` : undefined;
  }
  if ((item.type === "agentMessage" || item.type === "plan") && typeof item.text === "string" && item.text.trim()) return `${item.type === "plan" ? "Codex plan" : "Codex"}: ${item.text.trim()}\n\n`;
  return;
}

export class SessionReferences {
  private jobs = new Map<string, Job>();
  private cache = new Map<string, string>();
  constructor(private db: ControlPlaneDatabase, private registry: RegistryService, private coordination: CoordinationService, private ai: WritingAI) {}
  private identity(principal: Principal, sourceId: string): Identity {
    const session = this.registry.getSession(principal, sourceId);
    const host = this.db.get<{ name: string }>("SELECT name FROM machines WHERE machine_id=? AND workspace_id=?", session.machineId, principal.workspaceId);
    const version = `${session.projectionEpoch}:${session.contentEpoch}:${session.latestSessionSeq}`;
    return { id: sourceId, host: host?.name || session.machineId, project: session.projectAlias, title: session.title, link: `/sessions/${encodeURIComponent(sourceId)}`, version, incomplete: session.historyCompleteness !== "complete" };
  }
  start(principal: Principal, sourceId: string) {
    const identity = this.identity(principal, sourceId);
    invariant(this.ai.read(principal).enabled && this.ai.read(principal).configured, 409, "REFERENCE_AI_UNAVAILABLE", "Configure and enable the panel AI model to summarize a session");
    const key = `${principal.workspaceId}:${principal.userId}:${sourceId}:${identity.version}:conversation:${this.ai.referenceConfigurationVersion(principal)}`;
    for (const [id, job] of this.jobs) if (Date.now() - job.createdAt > 6 * 60 * 60_000) { job.controller.abort(); this.jobs.delete(id); }
    invariant([...this.jobs.values()].filter(job => job.owner === principal.userId && job.state !== "ready" && job.state !== "failed").length < 4, 429, "REFERENCE_BUSY", "Too many session summaries are running");
    const job: Job = { id: randomUUID(), owner: principal.userId, workspace: principal.workspaceId, sourceId, identity, state: "reading", done: 0, total: 1, controller: new AbortController(), createdAt: Date.now() };
    this.jobs.set(job.id, job);
    const cached = this.cache.get(key);
    if (cached) { job.state = "ready"; job.summary = cached; job.done = job.total = 1; }
    else void this.run(principal, job, key);
    return this.publicJob(job);
  }
  status(principal: Principal, id: string) {
    const job = this.owned(principal, id);
    this.identity(principal, job.sourceId); // Cached summaries never bypass source access/deletion checks.
    return this.publicJob(job);
  }
  cancel(principal: Principal, id: string) {
    const job = this.owned(principal, id);
    job.controller.abort(); this.jobs.delete(id);
    return { cancelled: true };
  }
  private owned(principal: Principal, id: string) {
    const job = this.jobs.get(id);
    invariant(job && job.owner === principal.userId && job.workspace === principal.workspaceId, 404, "REFERENCE_NOT_FOUND", "Session reference task was not found");
    return job;
  }
  private publicJob(job: Job) { return { id: job.id, state: job.state, done: job.done, total: job.total, identity: job.identity, ...(job.summary ? { summary: job.summary } : {}), ...(job.error ? { error: job.error } : {}) }; }
  private async run(principal: Principal, job: Job, key: string) {
    try {
      const [projectionEpoch, contentEpoch, throughSeq] = job.identity.version.split(":").map(Number);
      let beforeSeq: number | undefined;
      const pageCursors: Array<number | undefined> = [];
      let incomplete = job.identity.incomplete;
      let totalChars = 0;
      const readPage = (cursor: number | undefined) => {
        const page = this.coordination.historyPage(principal, job.sourceId, { limit: 200, ...(cursor ? { beforeSeq: cursor } : {}), projectionEpoch: projectionEpoch!, contentEpoch: contentEpoch! });
        invariant(page.throughSeq === throughSeq, 409, "REFERENCE_CHANGED", "Source session changed during summary; retry");
        return page;
      };
      // First pass keeps only page cursors and a character count. Tool output is
      // inspected for availability but never copied into the model prompt.
      do {
        if (job.controller.signal.aborted) return;
        const page = readPage(beforeSeq);
        const events = page.items as Record<string, unknown>[];
        if (events.some(event => event.payloadState !== "present")) incomplete = true;
        for (const event of events) totalChars += conversationText(event)?.length ?? 0;
        pageCursors.push(beforeSeq);
        beforeSeq = typeof page.nextBeforeSeq === "number" ? page.nextBeforeSeq : undefined;
        job.done = pageCursors.length; job.total = pageCursors.length + (beforeSeq ? 1 : 0);
      } while (beforeSeq);
      job.identity.incomplete = incomplete;
      invariant(totalChars > 0, 422, "REFERENCE_EMPTY", "No synchronized user or Codex conversation messages are available");
      const pieces: string[] = [];
      const chronologicalCursors = [...pageCursors].reverse();
      job.done = 0; job.total = totalChars <= 100_000 ? 1 : Math.ceil(totalChars / CHUNK_CHARS); job.state = "summarizing";
      if (totalChars <= 100_000) {
        let conversation = "";
        for (const cursor of chronologicalCursors) {
          if (job.controller.signal.aborted) return;
          for (const event of readPage(cursor).items as Record<string, unknown>[]) conversation += conversationText(event) ?? "";
        }
        try {
          pieces.push(await this.ai.summarizeHistory(principal, `Summarize this complete synchronized user and Codex conversation as one handoff. Do not infer the contents of omitted reasoning or command output:\n${conversation}`, job.controller.signal));
          job.done = 1;
        } catch (error) {
          if (!(error instanceof AppError && ["REFERENCE_CONTEXT_LIMIT", "REFERENCE_AI_TRUNCATED"].includes(error.code))) throw error;
          // A provider may advertise a smaller context than its model name
          // suggests. Fall back only when it explicitly rejects/truncates.
        }
      }
      if (!pieces.length) {
        job.done = 0; job.total = Math.ceil(totalChars / CHUNK_CHARS);
        let chunk = "";
        const summarizeChunk = async () => {
          if (!chunk || job.controller.signal.aborted) return;
          pieces.push(await this.ai.summarizeHistory(principal, `Part ${job.done + 1}/${job.total} of the synchronized user and Codex conversation. Do not infer the contents of omitted reasoning or command output:\n${chunk}`, job.controller.signal));
          job.done++;
          chunk = "";
        };
        for (const cursor of chronologicalCursors) {
          if (job.controller.signal.aborted) return;
          const page = readPage(cursor);
          for (const event of page.items as Record<string, unknown>[]) {
            const message = conversationText(event);
            if (!message) continue;
            for (let offset = 0; offset < message.length;) {
              const take = Math.min(CHUNK_CHARS - chunk.length, message.length - offset);
              chunk += message.slice(offset, offset + take);
              offset += take;
              if (chunk.length === CHUNK_CHARS) await summarizeChunk();
            }
          }
        }
        await summarizeChunk();
      }
      let summaries = pieces;
      while (summaries.length > 1) {
        job.state = "combining"; job.done = 0; job.total = Math.ceil(summaries.length / 6);
        const next: string[] = [];
        for (let index = 0; index < summaries.length; index += 6) {
          if (job.controller.signal.aborted) return;
          next.push(await this.ai.summarizeHistory(principal, `Combine these ordered conversation summaries into one handoff summary. Do not invent details from omitted reasoning or command logs:\n${summaries.slice(index, index + 6).map((s, i) => `Part ${index + i + 1}: ${s}`).join("\n\n")}`, job.controller.signal));
          job.done++;
        }
        summaries = next;
      }
      if (job.controller.signal.aborted) return;
      job.summary = `[Scope: synchronized user messages, Codex replies and plans only. Reasoning summaries and command execution logs were not summarized.]\n${incomplete ? "[Some source history was not synchronized or is no longer readable.]\n" : ""}\n${summaries[0]}`;
      job.state = "ready"; job.done = job.total = 1;
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, job.summary);
    } catch (error) {
      if (job.controller.signal.aborted) return;
      job.state = "failed";
      job.error = error instanceof AppError ? error.message : error instanceof Error ? error.message : "Summary failed";
    }
  }
}
