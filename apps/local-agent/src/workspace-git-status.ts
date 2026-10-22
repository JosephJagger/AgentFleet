import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface WorkspaceGitStatus { cwd: string; root: string; dirty: boolean; checkedAt: string; fingerprint?: string }

/** Read metadata only. Git failure/non-repositories are unknown, never treated as clean. */
export async function readWorkspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus | null> {
  const options = { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8" as const, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } };
  try {
    const { stdout: root } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], options);
    const rootPath = root.replace(/\r?\n$/, "");
    const { stdout: status } = await exec("git", ["-C", rootPath, "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
    let fingerprint: string | undefined;
    if (status) {
      try {
        // Metadata only: detect same-path edits without reading/uploading file contents.
        // Index blob IDs detect staged-only edits, including an unchanged working file.
        const entries = status.split("\0").filter(Boolean);
        if (entries.length > 2048) throw new Error("Too many changes to fingerprint");
        const deadline = Date.now() + 2000;
        const hash = createHash("sha256").update(status);
        for (let i = 0; i < entries.length; i++) {
          if (Date.now() > deadline) throw new Error("Fingerprint time budget exceeded");
          const entry = entries[i]!;
          const path = entry.slice(3);
          if (/R|C/.test(entry.slice(0, 2))) i++; // porcelain -z: destination then source
          try {
            const stat = await lstat(join(rootPath, path), { bigint: true });
            // A dirty submodule cannot be identified by its directory timestamp.
            if (stat.isDirectory()) throw new Error("Directory fingerprint unavailable");
            hash.update(JSON.stringify([path, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.mode.toString()]));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            hash.update(JSON.stringify([path, "missing"]));
          }
        }
        const { stdout: index } = await exec("git", ["-C", rootPath, "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-renames"], options);
        const { stdout: head } = await exec("git", ["-C", rootPath, "rev-parse", "--revs-only", "HEAD"], options);
        fingerprint = hash.update(index).update(head).digest("hex");
      } catch { /* Keep the reminder, but do not allow an unverifiable dismissal. */ }
    }
    return { cwd, root: rootPath, dirty: status.length > 0, checkedAt: new Date().toISOString(), ...(fingerprint ? { fingerprint } : {}) };
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
