import { api } from "./api";
import { t } from "../i18n";
import type { HostOperation } from "./types";
import type { ProviderId } from "./provider-catalog";

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

/** Wait for a host operation; worktree setup scripts may install dependencies, so allow them time. */
export async function waitForOperation(operation: HostOperation, timeoutMs = 20 * 60_000): Promise<HostOperation> {
  const deadline = Date.now() + timeoutMs;
  while (operation.state === "accepted" || operation.state === "running") {
    if (Date.now() >= deadline) throw new Error(t("主机仍在处理，请稍后刷新"));
    await sleep(800);
    operation = await api.readHostOperation(operation.id);
  }
  if (operation.state !== "succeeded") throw new Error(operation.error?.message ?? t("主机操作未完成，请重试"));
  return operation;
}

/** The host registers a new lane project asynchronously; find it by directory and agent. */
export async function laneProjectId(machineId: string, root: string, provider: ProviderId): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const page = await api.projects({ machineId, q: root.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? root, limit: 100 });
    const project = page.items.find(item => item.pathHint === root && (item.provider ?? "codex") === provider);
    if (project) return project.id;
    await sleep(700);
  }
  throw new Error(t("工作树已创建，但项目尚未同步到面板，请稍后刷新"));
}

/** The copied conversation shows up as a claimable native session; take it over so it can be continued right away. */
async function claimedForkSession(machineId: string, laneId: string, nativeThreadId: string): Promise<{ id: string; claimed: boolean }> {
  const find = async () => (await api.sessions({ machineId, projectId: laneId, limit: 50 })).items.find(item => item.nativeThreadId === nativeThreadId);
  let session = await find();
  for (let attempt = 0; !session && attempt < 40; attempt += 1) { await sleep(800); session = await find(); }
  if (!session) throw new Error(t("工作树和会话副本已创建，但会话尚未同步到面板。请稍后在「使用已有工作树」中打开。"));
  if (session.state.ownership === "agentfleet_owned") return { id: session.id, claimed: true };
  try {
    await api.command(session.id, { type: "thread.claim", payload: {}, clientMutationId: crypto.randomUUID(),
      precondition: { nativeThreadId, threadControlVersion: session.threadControlVersion, expectedActiveTurnId: null, projectLeaseVersion: session.projectLeaseVersion } });
  } catch { return { id: session.id, claimed: false }; }
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(1000);
    if ((await find())?.state.ownership === "agentfleet_owned") return { id: session.id, claimed: true };
  }
  return { id: session.id, claimed: false };
}

/**
 * Create (or join) a lane on the host and open a session in it: a blank one for the chosen agent, or, with
 * `forkSessionId`, a copy of that Codex conversation. The original session is never touched.
 */
export async function startLaneSession(projectId: string, machineId: string, input: { provider: ProviderId; name?: string; branch?: string; base?: string; adoptPath?: string; forkSessionId?: string; setup: boolean }, title: string) {
  const operation = await waitForOperation(await api.createWorktree(projectId, input, crypto.randomUUID()));
  const result = operation.result ?? {};
  const root = typeof result.canonicalRoot === "string" ? result.canonicalRoot : "";
  if (!root) throw new Error(t("主机未返回工作树目录"));
  const setup = result.setup && typeof result.setup === "object" ? result.setup as { ran?: boolean; ok?: boolean; output?: string } : undefined;
  if (setup?.ran && setup.ok === false) throw new Error(t("工作树已创建，但环境初始化失败。请检查初始化输出，修复后从项目列表创建会话。") + (setup.output ? `\n${setup.output.slice(-2000)}` : ""));
  const laneId = await laneProjectId(machineId, root, input.provider);
  const branch = typeof result.branch === "string" ? result.branch : "";
  if (input.forkSessionId) {
    const forked = typeof result.forkedNativeThreadId === "string" ? result.forkedNativeThreadId : "";
    if (!forked) throw new Error(t("工作树已创建，但这台主机没有复制会话。请更新主机连接服务后重试。"));
    const session = await claimedForkSession(machineId, laneId, forked);
    return { sessionId: session.id, laneProjectId: laneId, branch, setup, forked: true, claimed: session.claimed };
  }
  const created = await api.createSession(machineId, laneId, title);
  return { sessionId: created.session.id, laneProjectId: laneId, branch, setup, forked: false, claimed: true };
}
