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

/** Create (or join) a lane on the host and open a new session for the chosen agent in it. */
export async function startLaneSession(projectId: string, machineId: string, input: { provider: ProviderId; name?: string; base?: string; adoptPath?: string; setup: boolean }, title: string) {
  const operation = await waitForOperation(await api.createWorktree(projectId, input, crypto.randomUUID()));
  const result = operation.result ?? {};
  const root = typeof result.canonicalRoot === "string" ? result.canonicalRoot : "";
  if (!root) throw new Error(t("主机未返回工作树目录"));
  const setup = result.setup && typeof result.setup === "object" ? result.setup as { ran?: boolean; ok?: boolean; output?: string } : undefined;
  if (setup?.ran && setup.ok === false) throw new Error(t("工作树已创建，但环境初始化失败。请检查初始化输出，修复后从项目列表创建会话。") + (setup.output ? `\n${setup.output.slice(-2000)}` : ""));
  const laneId = await laneProjectId(machineId, root, input.provider);
  const created = await api.createSession(machineId, laneId, title);
  return { sessionId: created.session.id, laneProjectId: laneId, branch: typeof result.branch === "string" ? result.branch : "", setup };
}
