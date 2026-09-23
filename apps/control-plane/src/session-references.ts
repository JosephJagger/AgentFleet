import { randomUUID } from "node:crypto";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { CoordinationService } from "./coordination.js";
import { AppError, invariant } from "./errors.js";
import type { WritingAI } from "./writing-ai.js";

type Identity = { id: string; host: string; project: string; title: string; link: string; version: string; incomplete: boolean };
type Job = { id: string; owner: string; workspace: string; sourceId: string; state: "reading" | "summarizing" | "combining" | "ready" | "failed"; done: number; total: number; identity: Identity; summary?: string; error?: string; controller: AbortController; createdAt: number };

function readable(event: Record<string, unknown>): string | undefined {
  if (event.payloadState !== "present") return;
  const payload = event.payload as Record<string, unknown> | undefined;
  const item = payload?.item as Record<string, unknown> | undefined;
  if (!item) {
    const message = payload?.message;
    return typeof message === "string" && message.trim() ? `Event: ${message.trim()}` : undefined;
  }
  let body = "";
  if (item.type === "userMessage" && Array.isArray(item.content)) body = item.content.map(part => typeof part === "object" && part && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, string>).text : "").filter(Boolean).join("\n");
  if (item.type === "agentMessage" || item.type === "plan") body = typeof item.text === "string" ? item.text : "";
  if (item.type === "reasoning" && Array.isArray(item.summary)) body = item.summary.filter(value => typeof value === "string").join("\n");
  if (item.type === "commandExecution") body = [item.command, item.aggregatedOutput].filter(value => typeof value === "string").join("\n");
  if (item.type === "fileChange") body = typeof item.changes === "string" ? item.changes : "";
  if (!body.trim()) return;
  return `${item.type === "userMessage" ? "User" : item.type === "commandExecution" ? "Tool" : "Codex"}: ${body.trim()}`;
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
    const key = `${principal.workspaceId}:${principal.userId}:${sourceId}:${identity.version}:${this.ai.referenceConfigurationVersion(principal)}`;
    for (const [id, job] of this.jobs) if (Date.now() - job.createdAt > 30 * 60_000) { job.controller.abort(); this.jobs.delete(id); }
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
      const pages: string[][] = [];
      let incomplete = job.identity.incomplete;
      do {
        if (job.controller.signal.aborted) return;
        const page = this.coordination.historyPage(principal, job.sourceId, { limit: 200, ...(beforeSeq ? { beforeSeq } : {}), projectionEpoch: projectionEpoch!, contentEpoch: contentEpoch! });
        invariant(page.throughSeq === throughSeq, 409, "REFERENCE_CHANGED", "Source session changed during summary; retry");
        const events = page.items as Record<string, unknown>[];
        if (events.some(event => event.payloadState !== "present")) incomplete = true;
        pages.push(events.map(readable).filter((item): item is string => Boolean(item)));
        beforeSeq = typeof page.nextBeforeSeq === "number" ? page.nextBeforeSeq : undefined;
        invariant(pages.length <= 500, 413, "REFERENCE_TOO_LARGE", "Synced session history is too large to summarize safely");
      } while (beforeSeq);
      job.identity.incomplete = incomplete;
      const messages = pages.reverse().flat();
      invariant(messages.reduce((total, value) => total + value.length, 0) <= 2_000_000, 413, "REFERENCE_TOO_LARGE", "Synced readable history exceeds the safe summary limit");
      invariant(messages.length, 422, "REFERENCE_EMPTY", "No synchronized readable messages are available");
      const chunks: string[] = [];
      let chunk = "";
      for (const message of messages) {
        for (let offset = 0; offset < message.length; offset += 12_000) {
          const part = message.slice(offset, offset + 12_000);
          if (chunk.length + part.length > 15_000 && chunk) { chunks.push(chunk); chunk = ""; }
          chunk += `${part}\n\n`;
        }
      }
      if (chunk) chunks.push(chunk);
      job.total = chunks.length; job.state = "summarizing";
      const pieces: string[] = [];
      for (const [index, item] of chunks.entries()) {
        if (job.controller.signal.aborted) return;
        pieces.push(await this.ai.summarizeHistory(principal, `Part ${index + 1}/${chunks.length} of synchronized session history:\n${item}`, job.controller.signal));
        job.done = index + 1;
      }
      let summaries = pieces;
      while (summaries.length > 1) {
        job.state = "combining"; job.done = 0; job.total = Math.ceil(summaries.length / 6);
        const next: string[] = [];
        for (let index = 0; index < summaries.length; index += 6) {
          if (job.controller.signal.aborted) return;
          next.push(await this.ai.summarizeHistory(principal, `Combine these ordered partial summaries into one coherent session summary. Preserve important details and unresolved work:\n${summaries.slice(index, index + 6).map((s, i) => `Part ${index + i + 1}: ${s}`).join("\n\n")}`, job.controller.signal));
          job.done++;
        }
        summaries = next;
      }
      if (job.controller.signal.aborted) return;
      job.summary = `${incomplete ? "[Some source history was not synchronized or is no longer readable. This summarizes only synchronized readable messages.]\n\n" : ""}${summaries[0]}`;
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
