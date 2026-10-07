import { readFile, readlink, mkdir, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_VERSION } from "./constants.js";
import { AgentError } from "./errors.js";
import { prepareUpdateTransaction, readUpdateTransaction, stableAgentExecutable, writeUpdateTransaction } from "./supervisor.js";
import { StateStore } from "./store.js";
import { restoreUpdateTransaction } from "./supervisor.js";
import { delay } from "./util.js";

/** Both interactive installers and background updates use the same durable activation record. */
export async function installationStep(dataDir: string, action: string): Promise<void> {
  let transaction = await readUpdateTransaction(dataDir);
  if (action === "prepare") {
    if (transaction?.phase === "preparing" && transaction.ownerPid) {
      let dead = false;
      try { process.kill(transaction.ownerPid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (dead) { await restoreUpdateTransaction(dataDir, transaction, "Previous installer was interrupted before activation"); transaction = await readUpdateTransaction(dataDir); }
    }
    if (transaction && ["preparing", "staged", "verifying"].includes(transaction.phase)) {
      if (transaction.phase === "preparing" && transaction.targetVersion === AGENT_VERSION && process.env.AGENTFLEET_SUPERVISED === "1") return;
      throw new AgentError("UPDATE_IN_PROGRESS", "上一轮安装仍待确认，请先恢复连接或核验升级结果。");
    }
    const store = new StateStore(dataDir); await store.initialize();
    try {
      const state = store.snapshot();
      const failedClaims = Object.keys(state.commandJournal).filter(id => state.commandJournal[id]?.commandType === "thread.claim");
      if (!store.canSafelyRestart(failedClaims)) throw new AgentError("UPDATE_HOST_BUSY", "主机仍有任务、通话或待核验操作，请先恢复连接；不会强制终止任务。");
      await store.setMaintenanceDrain(`installer-update-${AGENT_VERSION}`);
      try { await prepareUpdateTransaction(dataDir, AGENT_VERSION); }
      catch (error) { await store.setMaintenanceDrain(undefined); throw error; }
    } finally { store.close(); }
    return;
  }
  if (!transaction || transaction.targetVersion !== AGENT_VERSION) throw new AgentError("UPDATE_TARGET_CHANGED", "升级目标已变化，已停止本次操作。");
  if (action === "abort") {
    if (transaction.phase === "rolled_back") return;
    await restoreUpdateTransaction(dataDir, transaction, "Service activation failed; restoring the previous installation");
    return;
  }
  if (action === "staged") {
    if (transaction.phase !== "preparing") throw new AgentError("UPDATE_PHASE_CHANGED", "升级阶段已变化，禁止重复切换。");
    await writeUpdateTransaction(dataDir, { ...transaction, phase: "staged" });
    return;
  }
  if (action !== "wait") throw new AgentError("ARGUMENT_INVALID", "installation requires prepare, staged or wait");
  const id = transaction.updateId;
  for (let attempt = 0; attempt < 150; attempt++) {
    transaction = await readUpdateTransaction(dataDir);
    if (!transaction || transaction.updateId !== id) throw new AgentError("UPDATE_TARGET_CHANGED", "升级记录已变化，请查看主机实际状态。");
    if (transaction.phase === "succeeded" && transaction.verifiedAt) return;
    if (transaction.phase === "rolled_back" && transaction.rollbackVerifiedAt) throw new AgentError("UPDATE_ROLLED_BACK", `升级失败，已确认旧版 ${transaction.previousVersion} 恢复连接：${transaction.error ?? "新版本未通过健康检查"}`);
    await delay(1_000);
  }
  throw new AgentError("UPDATE_HEALTH_PENDING", "安装已提交，但尚未收到连接与健康回执；不能认定升级成功。请查看面板，不要重复安装。");
}

export async function agentUpdateDiagnostics(dataDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = { agentRunningVersion: AGENT_VERSION };
  try {
    const installed = process.platform === "win32" ? (await readFile(join(dataDir, "bin/current.txt"), "utf8")).trim() : basename(dirname(await readlink(stableAgentExecutable(dataDir))));
    if (/^\d+\.\d+\.\d+$/.test(installed)) result.agentInstalledVersion = installed;
  } catch { /* Running is known, installation pointer may be unavailable. */ }
  const transaction = await readUpdateTransaction(dataDir);
  if (transaction) {
    result.agentUpdateState = transaction.phase;
    result.agentUpdateTarget = transaction.targetVersion ?? "";
    result.agentUpdateError = transaction.error ?? "";
    result.agentUpdateCheckedAt = transaction.updatedAt ?? transaction.startedAt;
    result.agentRollbackVersion = transaction.previousVersion;
    result.agentUpdateVerifiedAt = transaction.verifiedAt ?? transaction.rollbackVerifiedAt ?? "";
  }
  try {
    const progress = JSON.parse(await readFile(join(dataDir, "update-progress.json"), "utf8"));
    if (typeof progress.updatedAt === "string" && progress.updatedAt > (transaction?.updatedAt ?? transaction?.startedAt ?? "")) {
      result.agentUpdateState = String(progress.phase).slice(0, 64);
      result.agentUpdateTarget = String(progress.targetVersion).slice(0, 32);
      result.agentUpdateError = String(progress.error ?? "").slice(0, 500);
      result.agentUpdateCheckedAt = progress.updatedAt;
    }
  } catch { /* No prior automatic check. */ }
  return result;
}

export async function recordUpdateProgress(dataDir: string, phase: string, targetVersion: string, error = ""): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "update-progress.json"), temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ phase, targetVersion, error: error.slice(0, 500), updatedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  await rename(temp, path);
}
