import { sessionFromPath } from "./session-workspace";

export interface SessionReferenceIdentity { id: string; host: string; project: string; title: string; link: string; version: string; incomplete: boolean }
export interface SessionReferenceJob { id: string; state: "reading" | "summarizing" | "combining" | "ready" | "failed"; done: number; total: number; identity: SessionReferenceIdentity; summary?: string; error?: string }
export function referenceIdFromText(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value.trim(), origin);
    if (url.origin !== origin || url.search || url.hash) return;
    return sessionFromPath(url.pathname);
  } catch { return; }
}
export function referencePrompt(draft: string, jobs: SessionReferenceJob[], origin: string): string {
  if (!jobs.length) return draft.trim();
  if (jobs.some(job => job.state !== "ready" || !job.summary)) throw new Error("Session summaries must finish before sending");
  const blocks = jobs.map(job => {
    const source = job.identity;
    return `[Referenced Codex session — fixed summary snapshot]\nHost: ${source.host}\nProject: ${source.project}\nSession: ${source.title}\nSession ID: ${source.id}\nLink: ${new URL(source.link, origin).href}\nSource content version: ${source.version}\nHistory: ${source.incomplete ? "Some history was not synchronized or readable" : "Synchronized conversation history"}\nScope: User messages, Codex replies and plans; reasoning and command execution excluded.\nSummary:\n${job.summary}\n[/Referenced Codex session]`;
  });
  return `${draft.trim()}${draft.trim() ? "\n\n" : ""}${blocks.join("\n\n")}`;
}
