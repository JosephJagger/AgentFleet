import { Worker } from "node:worker_threads";
export type SemanticMatch = { intent: string; score: number };
/** Local CPU worker; never send drafts to a provider, persist them, or block event ingress. */
export class WritingSemantic {
  private worker: Worker | undefined;
  private ready = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (matches: SemanticMatch[]) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(modelPath = process.env.WRITING_MODEL_PATH) {
    if (!modelPath) return;
    this.worker = new Worker(new URL("./writing-semantic-worker.js", import.meta.url), { workerData: { modelPath }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.worker.on("message", (message: { ready?: boolean; id?: number; matches?: SemanticMatch[] }) => {
      if (message.ready) { this.ready = true; return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message.matches ?? []); }
    });
    this.worker.on("error", () => this.reset());
    this.worker.on("exit", () => this.reset());
  }
  status() { return this.ready ? "ready" : this.worker ? "warming" : "unavailable"; }
  private reset() {
    this.ready = false; this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
    this.pending.clear();
  }
  search(text: string): Promise<SemanticMatch[]> {
    if (!this.ready || !this.worker || this.pending.size >= 4) return Promise.resolve([]);
    const id = ++this.sequence;
    return new Promise(resolve => {
      // Retain the admission slot until inference actually ends, even if the caller times out.
      const timer = setTimeout(() => resolve([]), 1500);
      this.pending.set(id, { resolve, timer }); this.worker!.postMessage({ id, text });
    });
  }
  async close() { const worker = this.worker; this.reset(); if (worker) await worker.terminate(); }
}
