import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface WorkspaceGitStatus { cwd: string; root: string; dirty: boolean; checkedAt: string }

/** Read metadata only. Git failure/non-repositories are unknown, never treated as clean. */
export async function readWorkspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus | null> {
  const options = { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8" as const, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } };
  try {
    const { stdout: root } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], options);
    const { stdout: status } = await exec("git", ["-C", cwd, "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], options);
    return { cwd, root: root.replace(/\r?\n$/, ""), dirty: status.length > 0, checkedAt: new Date().toISOString() };
  } catch { return null; }
}

/** Bounded background sampling; never delays heartbeats or starts a model/tool turn. */
export class WorkspaceGitStatusSampler {
  private readonly entries = new Map<string, { attemptedAt: number; value: WorkspaceGitStatus | null }>();
  private pending: Promise<void> | undefined;
  constructor(private readonly read = readWorkspaceGitStatus) {}
  snapshot(now = Date.now()): WorkspaceGitStatus[] {
    return [...this.entries.values()].flatMap(entry => entry.value && now - Date.parse(entry.value.checkedAt) < 120_000 ? [entry.value] : []);
  }
  refresh(paths: string[], now = Date.now()): Promise<void> {
    if (this.pending) return this.pending;
    const wanted = new Set(paths);
    for (const path of this.entries.keys()) if (!wanted.has(path)) this.entries.delete(path);
    const queue = [...wanted].filter(path => now - (this.entries.get(path)?.attemptedAt ?? -Infinity) >= 30_000)
      .sort((a, b) => (this.entries.get(a)?.attemptedAt ?? 0) - (this.entries.get(b)?.attemptedAt ?? 0)).slice(0, 64);
    this.pending = Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const path = queue.shift();
        if (!path) return;
        const value = await this.read(path).catch(() => null);
        this.entries.set(path, { attemptedAt: now, value });
      }
    })).then(() => undefined).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
