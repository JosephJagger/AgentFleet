import { syncDirectory } from "./durable-file.js";
import { open } from "node:fs/promises";
import { withVersionLock } from "./version-cleanup.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AGENT_VERSION } from "./constants.js";
import { acquireSupervisorLease, hasLiveRuntimeOwner } from "./supervisor-ownership.js";
import { AgentError } from "./errors.js";
import { isPathInside } from "./util.js";

export interface UpdateTransaction {
  updateId: string;
  ownerPid?: number;
  history?: Array<{phase: string; at: string}>;
  phase: "preparing" | "staged" | "verifying" | "succeeded" | "rolled_back" | "failed";
  previousVersion: string;
  targetVersion?: string;
  targetRuntimeVersion?: string;
  targetRuntimeRevision?: string;
  backupDir: string;
  launcher: string;
  previousTarget: string;
  profilePresent: boolean;
  codexPresent: boolean;
  sandboxHelperPresent?: boolean;
  startedAt: string;
  error?: string;
  failureCode?: string;
  retryable?: boolean;
  attempts?: number;
  updatedAt?: string;
  verifiedAt?: string;
  rollbackVerifiedAt?: string;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AgentError("UPDATE_PATH_UNSAFE", "update file is not a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function stableAgentExecutable(dataDir: string): string {
  return process.platform === "win32" ? join(dataDir, "agentfleet.cmd") : join(homedir(), ".local", "bin", "agentfleet");
}

export async function readUpdateTransaction(dataDir: string): Promise<UpdateTransaction | undefined> {
  const path = join(dataDir, "update-state.json");
  if (!await regularFile(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as UpdateTransaction;
  if (typeof value.updateId !== "string" || typeof value.backupDir !== "string" || !isPathInside(join(dataDir, "updates"), value.backupDir) ||
    !["preparing", "staged", "verifying", "succeeded", "rolled_back", "failed"].includes(value.phase)) {
    throw new AgentError("UPDATE_STATE_INVALID", "persistent update transaction is invalid");
  }
  return value;
}

export async function writeUpdateTransaction(dataDir: string, value: UpdateTransaction): Promise<void> {
  const path = join(dataDir, "update-state.json");
  await regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const at = new Date().toISOString();
  const previous = await readUpdateTransaction(dataDir);
  if (previous && previous.updateId !== value.updateId && value.phase !== "preparing") throw new AgentError("UPDATE_TARGET_CHANGED", "升级事务已变化，禁止旧事务覆盖新结果。");
  if (previous?.updateId === value.updateId && previous.phase !== value.phase) {
    const transitions: Record<string, string[]> = { preparing:["staged","rolled_back","failed"], staged:["verifying","rolled_back","failed"], verifying:["succeeded","rolled_back","failed"], succeeded:[], rolled_back:[], failed:["rolled_back"] };
    if (!transitions[previous.phase]?.includes(value.phase)) throw new AgentError("UPDATE_PHASE_CHANGED", "升级状态已变化，已忽略迟到的状态写入。");
  }
  const history = [...(previous?.updateId === value.updateId ? previous.history ?? [] : [])];
  if (history.at(-1)?.phase !== value.phase) history.push({ phase: value.phase, at });
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ ...value, history: history.slice(-32), updatedAt: at })); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  await syncDirectory(dataDir);
}

export async function prepareUpdateTransaction(dataDir: string, targetVersion: string, launcher = stableAgentExecutable(dataDir)): Promise<UpdateTransaction> {
  return withVersionLock(dataDir, () => prepareUpdateTransactionLocked(dataDir, targetVersion, launcher));
}
async function prepareUpdateTransactionLocked(dataDir: string, targetVersion: string, launcher: string): Promise<UpdateTransaction> {
  const current = await readUpdateTransaction(dataDir);
  if (current && ["preparing","staged","verifying"].includes(current.phase)) throw new AgentError("UPDATE_IN_PROGRESS", "已有升级事务尚未确认，不能再次切换版本。");
  await mkdir(join(dataDir, "updates"), { recursive: true, mode: 0o700 });
  const metadata = await lstat(join(dataDir, "updates"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AgentError("UPDATE_PATH_UNSAFE", "updates directory is not a regular directory");
  const backupDir = await mkdtemp(join(dataDir, "updates", "release-"));
  const profilePath = join(dataDir, "runtime-profile.json");
  const codexPath = join(dataDir, "codex", process.platform === "win32" ? "codex.exe" : "codex");
  const profilePresent = await regularFile(profilePath);
  const codexPresent = await regularFile(codexPath);
  const helperPath = join(dataDir, "codex", "codex-resources", "bwrap");
  const sandboxHelperPresent = process.platform === "linux" ? await regularFile(helperPath) : undefined;
  if (profilePresent) await copyFile(profilePath, join(backupDir, "runtime-profile.json"));
  if (codexPresent) await copyFile(codexPath, join(backupDir, "codex"));
  if (sandboxHelperPresent) await copyFile(helperPath, join(backupDir, "bwrap"));
  const previousTarget = process.platform === "win32"
    ? (await readFile(join(dataDir, "bin", "current.txt"), "utf8")).trim()
    : await readlink(launcher);
  if (process.platform === "win32" && !/^\d+\.\d+\.\d+$/.test(previousTarget)) throw new AgentError("UPDATE_STATE_INVALID", "Windows release pointer must contain a version");
  if (process.platform !== "win32" && !isPathInside(join(dirname(dataDir), "agentfleet", "bin"), previousTarget) &&
    !isPathInside(join(homedir(), ".local", "share", "agentfleet", "bin"), previousTarget)) {
    throw new AgentError("UPDATE_PATH_UNSAFE", "current launcher does not target an AgentFleet release");
  }
  const transaction: UpdateTransaction = { updateId: randomUUID(), ownerPid: Number(process.env.AGENTFLEET_INSTALLER_PID) || process.pid, phase: "preparing", previousVersion: process.platform === "win32" ? previousTarget : basename(dirname(previousTarget)),
    targetVersion, backupDir, launcher, previousTarget, profilePresent, codexPresent, ...(sandboxHelperPresent !== undefined ? { sandboxHelperPresent } : {}), startedAt: new Date().toISOString() };
  await writeUpdateTransaction(dataDir, transaction);
  return transaction;
}

export async function restoreUpdateTransaction(dataDir: string, transaction: UpdateTransaction, reason: string): Promise<void> {
  const current = await readUpdateTransaction(dataDir);
  if (current && (current.updateId !== transaction.updateId || current.phase === "succeeded")) throw new AgentError("UPDATE_TARGET_CHANGED", "升级事务已变化，禁止回退已确认的新版本。");
  if (!isPathInside(join(dataDir, "updates"), transaction.backupDir) || transaction.launcher !== stableAgentExecutable(dataDir)) {
    throw new AgentError("UPDATE_PATH_UNSAFE", "rollback transaction does not belong to this installation");
  }
  for (const [present, source, destination] of [
    [transaction.profilePresent, join(transaction.backupDir, "runtime-profile.json"), join(dataDir, "runtime-profile.json")],
    [transaction.codexPresent, join(transaction.backupDir, "codex"), join(dataDir, "codex", process.platform === "win32" ? "codex.exe" : "codex")],
    ...((transaction.sandboxHelperPresent !== undefined && process.platform === "linux") ? [[transaction.sandboxHelperPresent, join(transaction.backupDir, "bwrap"), join(dataDir, "codex", "codex-resources", "bwrap")] as const] : []),
  ] as const) {
    const exists = await regularFile(destination);
    if (present) {
      if (!await regularFile(source)) throw new AgentError("ROLLBACK_BACKUP_MISSING", "update rollback backup is missing");
      const temporary = `${destination}.${randomUUID()}.restore`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    } else if (exists) await unlink(destination);
  }
  if (process.platform === "win32") {
    if (!/^\d+\.\d+\.\d+$/.test(transaction.previousTarget)) throw new AgentError("UPDATE_STATE_INVALID", "Windows rollback pointer is invalid");
    const pointer = join(dataDir, "bin", "current.txt");
    const temporary = `${pointer}.${randomUUID()}.restore`;
    await writeFile(temporary, transaction.previousTarget, { mode: 0o600 });
    await rename(temporary, pointer);
  } else {
    const binaryRoot = join(homedir(), ".local", "share", "agentfleet", "bin");
    const otherRoot = join(dataDir, "bin");
    if (!isPathInside(binaryRoot, transaction.previousTarget) && !isPathInside(otherRoot, transaction.previousTarget)) throw new AgentError("UPDATE_PATH_UNSAFE", "rollback target is outside managed releases");
    const temporary = `${transaction.launcher}.${randomUUID()}.restore`;
    await symlink(transaction.previousTarget, temporary);
    await rename(temporary, transaction.launcher);
  }
  await writeUpdateTransaction(dataDir, { ...transaction, phase: "rolled_back", error: reason.slice(0, 500) });
}

/** Read only this worker's acknowledgement; never publish the supervisor token. */
export async function workerHealthDiagnostics(dataDir: string): Promise<Record<string, unknown>> {
  const token = process.env.AGENTFLEET_SUPERVISOR_TOKEN;
  const supervised = process.env.AGENTFLEET_SUPERVISED === "1";
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return { supervised, tokenPresent: false, acknowledgement: "missing_token" };
  const path = join(dataDir, `worker-health-${token}.json`);
  try {
    if (!await regularFile(path)) return { supervised, tokenPresent: true, acknowledgement: "missing" };
    const health = JSON.parse(await readFile(path, "utf8")) as { token?: unknown; version?: unknown; runtimeVersion?: unknown };
    return { supervised, tokenPresent: true, acknowledgement: health.token === token ? "written" : "token_mismatch",
      version: typeof health.version === "string" ? health.version.slice(0, 32) : null,
      runtimeVersion: typeof health.runtimeVersion === "string" ? health.runtimeVersion.slice(0, 32) : null };
  } catch (error) { return { supervised, tokenPresent: true, acknowledgement: "unreadable", errorCode: error instanceof AgentError ? error.code : "HEALTH_ACK_READ_FAILED" }; }
}

export async function writeWorkerHealth(dataDir: string, runtimeVersion?: string): Promise<void> {
  const token = process.env.AGENTFLEET_SUPERVISOR_TOKEN;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return;
  const path = join(dataDir, `worker-health-${token}.json`), temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ token, version: AGENT_VERSION, runtimeVersion, observedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, path);
}

/** This parent uses its already-running version even when the child launcher is upgraded. */
export function shouldRestartWorker(exitCode: number | null, rolledBack: boolean): boolean {
  // A timed-out worker handles SIGTERM gracefully and commonly returns zero.
  // That must not stop the service after we have restored its previous release.
  return rolledBack || exitCode !== 0;
}

export function workerStopExitCode(supervised: boolean): number {
  // Older supervisors stop on zero even after rollback. A supervised child
  // requests a restart; the parent's abort signal still wins on service stop.
  return supervised ? 75 : 0;
}

export async function superviseAgent(dataDir: string, signal: AbortSignal): Promise<void> {
  const release = await acquireSupervisorLease(dataDir);
  if (!release) return;
  try {
    if (await hasLiveRuntimeOwner(dataDir)) return;
    await superviseOwnedAgent(dataDir, signal);
  } finally { release(); }
}

async function superviseOwnedAgent(dataDir: string, signal: AbortSignal): Promise<void> {
  const launcher = stableAgentExecutable(dataDir);
  while (!signal.aborted) {
    let transaction = await readUpdateTransaction(dataDir);
    if (transaction?.phase === "preparing") {
      await restoreUpdateTransaction(dataDir, transaction, "update process stopped before activation completed");
      transaction = await readUpdateTransaction(dataDir);
    }
    const verifying = transaction?.phase === "staged" || transaction?.phase === "verifying";
    if (verifying && transaction) await writeUpdateTransaction(dataDir, { ...transaction, phase: "verifying" });
    const token = randomUUID();
    const healthPath = join(dataDir, `worker-health-${token}.json`);
    const environment = { ...process.env, AGENTFLEET_SUPERVISED: "1", AGENTFLEET_SUPERVISOR_TOKEN: token,
      AGENTFLEET_WORKER_EXECUTABLE: launcher, AGENTFLEET_WORKER_DATA_DIR: dataDir };
    const child = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "& $env:AGENTFLEET_WORKER_EXECUTABLE run --data-dir $env:AGENTFLEET_WORKER_DATA_DIR; exit $LASTEXITCODE"], { env: environment, stdio: "inherit", windowsHide: true })
      : spawn(launcher, ["run", "--data-dir", dataDir], { env: environment, stdio: "inherit", detached: true });
    let healthy = false;
    let timedOut = false;
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* child already exited */ }
    };
    signal.addEventListener("abort", terminate, { once: true });
    const timeout = verifying ? setTimeout(() => { timedOut = true; terminate(); }, 90_000) : undefined;
    let checking = false;
    const healthCheck = setInterval(() => {
      if (checking || healthy) return;
      checking = true;
      void (async () => {
        if (!await regularFile(healthPath)) return;
        const health = JSON.parse(await readFile(healthPath, "utf8")) as { token?: string; version?: string; runtimeVersion?: string };
        if (health.token !== token || (verifying && health.version !== transaction?.targetVersion)) return;
        if (verifying && transaction?.targetRuntimeVersion && health.runtimeVersion !== transaction.targetRuntimeVersion) return;
        if (!verifying && transaction?.phase === "rolled_back" && health.version === transaction.previousVersion) {
          await writeUpdateTransaction(dataDir, { ...transaction, rollbackVerifiedAt: new Date().toISOString() });
        }
        healthy = true;
        if (timeout) clearTimeout(timeout);
        if (verifying && transaction) await writeUpdateTransaction(dataDir, { ...transaction, phase: "succeeded", verifiedAt: new Date().toISOString() });
      })().catch(() => undefined).finally(() => { checking = false; });
    }, 1_000);
    const code = await new Promise<number | null>((finish) => {
      child.once("error", () => finish(null));
      child.once("exit", (exitCode) => finish(exitCode));
    });
    clearInterval(healthCheck);
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", terminate);
    await unlink(healthPath).catch(() => undefined);
    if (signal.aborted) return;
    const rolledBack = Boolean(verifying && !healthy && transaction);
    if (rolledBack && transaction) {
      // A surviving worker owns the directory; never roll its profile back
      // because a competing wrapper failed to acquire the worker lease.
      if (await hasLiveRuntimeOwner(dataDir)) return;
      await restoreUpdateTransaction(dataDir, transaction, timedOut ? "new agent did not become healthy within 90 seconds" : `new agent exited before health confirmation (${code ?? "spawn error"})`);
    }
    if (!shouldRestartWorker(code, rolledBack)) return;
    if (code !== 75) await new Promise<void>((finish) => { const timer = setTimeout(finish, 5_000); signal.addEventListener("abort", () => { clearTimeout(timer); finish(); }, { once: true }); });
  }
}
