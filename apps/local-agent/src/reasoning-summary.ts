import type { AppEvent } from "./app-server.js";
import { redact, truncateUtf8 } from "./util.js";

type Entry = {
  threadId: string; turnId: string; itemId: string;
  parts: Map<number, string>; bytes: number; dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pending: Promise<void>;
};

/** Public summary deltas only. Persist bounded snapshots through the existing
 * item lifecycle so refresh, retention and content permissions remain shared.
 */
export class ReasoningSummaries {
  private entries = new Map<string, Entry>();
  private finished = new Set<string>();
  private finishedTurns = new Set<string>();
  private closed = false;
  constructor(private readonly emit: (event: AppEvent) => Promise<void>) {}
  private key(threadId: string, turnId: string, itemId: string) { return JSON.stringify([threadId, turnId, itemId]); }
  private summary(entry: Entry) {
    return [...entry.parts].sort(([a], [b]) => a - b).map(([, text]) => redact(text));
  }
  private flush(entry: Entry): Promise<void> {
    if (!entry.dirty) return entry.pending;
    entry.dirty = false;
    const summary = this.summary(entry);
    if (!summary.some(text => text.trim())) return entry.pending;
    entry.pending = entry.pending.catch(() => undefined).then(() => this.emit({
      type: "item.started", nativeThreadId: entry.threadId, nativeTurnId: entry.turnId, nativeItemId: entry.itemId,
      payload: { item: { type: "reasoning", id: entry.itemId, summary } },
    }));
    return entry.pending;
  }
  private schedule(entry: Entry) {
    entry.timer = setTimeout(() => {
      delete entry.timer;
      if (entry.dirty) {
        this.schedule(entry);
        void this.flush(entry).catch(() => undefined);
      }
    }, 1000);
    entry.timer.unref();
  }
  async append(params: Record<string, unknown>): Promise<void> {
    const { threadId, turnId, itemId, summaryIndex, delta } = params;
    if (this.closed || ![threadId, turnId, itemId].every(v => typeof v === "string" && v.length > 0 && v.length <= 256)
      || typeof summaryIndex !== "number" || !Number.isSafeInteger(summaryIndex) || summaryIndex < 0 || summaryIndex >= 32
      || typeof delta !== "string" || !delta) return;
    const key = this.key(threadId as string, turnId as string, itemId as string);
    if (this.finished.has(key) || this.finishedTurns.has(JSON.stringify([threadId, turnId]))) return;
    let entry = this.entries.get(key);
    if (!entry) {
      // Refuse excess concurrent items instead of dropping pending saved text.
      if (this.entries.size >= 64) return;
      entry = { threadId: threadId as string, turnId: turnId as string, itemId: itemId as string,
        parts: new Map(), bytes: 0, dirty: false, pending: Promise.resolve() };
      this.entries.set(key, entry);
    }
    const text = truncateUtf8(delta, Math.max(0, 64_000 - entry.bytes)).value;
    if (!text) return;
    entry.bytes += Buffer.byteLength(text);
    entry.parts.set(summaryIndex, (entry.parts.get(summaryIndex) ?? "") + text);
    entry.dirty = true;
    if (!entry.timer) {
      this.schedule(entry);
      await this.flush(entry);
    }
  }
  async complete(threadId: string, turnId: string, itemId: string, summary: string[]): Promise<string[]> {
    const key = this.key(threadId, turnId, itemId);
    this.finished.add(key);
    if (this.finished.size > 256) this.finished.delete(this.finished.values().next().value!);
    const entry = this.entries.get(key);
    if (!entry) return summary;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    await this.flush(entry);
    // A complete native summary is authoritative. An empty terminal event
    // must not erase public text that was actually received while streaming.
    return summary.some(text => text.trim()) ? summary : this.summary(entry);
  }
  async finishTurn(threadId: string, turnId: string): Promise<void> {
    this.finishedTurns.add(JSON.stringify([threadId, turnId]));
    if (this.finishedTurns.size > 256) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
    for (const entry of [...this.entries.values()]) if (entry.threadId === threadId && entry.turnId === turnId) {
      const summary = await this.complete(threadId, turnId, entry.itemId, []);
      if (summary.some(text => text.trim())) await this.emit({
        type: "item.completed", nativeThreadId: threadId, nativeTurnId: turnId, nativeItemId: entry.itemId,
        payload: { item: { type: "reasoning", id: entry.itemId, summary } },
      });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(entry => {
      if (entry.timer) clearTimeout(entry.timer);
      return this.flush(entry);
    }));
  }
}
