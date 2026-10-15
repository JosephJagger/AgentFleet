import { t } from "../i18n";
import type { Machine } from "./types";

const hash = (value?: string | null) => (value ?? "").toLowerCase().replace(/^sha256:/, "");

function pendingAgentTarget(target: string, running: string) {
  if (!target || target === running) return false;
  // Completed upgrades can leave an older operation's status in the profile.
  const stable = /^\d+\.\d+\.\d+$/;
  if (!stable.test(target) || !stable.test(running)) return true;
  const current = running.split(".").map(Number);
  const difference = target.split(".").map((part, i) => Number(part) - current[i]).find((part) => part !== 0);
  return difference !== undefined && difference > 0;
}

export function matchesRuntimeTarget(machine: Machine, version?: string, schemaHash?: string) {
  return Boolean(version && schemaHash && machine.codexVersion === version &&
    hash(machine.schemaHash) && hash(machine.schemaHash) === hash(schemaHash));
}

/** Update progress is separate from the backend's validation of the running version.
 * Only progress explicitly tied to the current target describes this rollout. */
export function runtimeRollout(machine: Machine, target?: string, schemaHash?: string, verified = true): { label: string; error?: string; failed?: boolean } {
  const profile = machine.codexProfile ?? {};
  const value = (key: string) => typeof profile[key] === "string" ? String(profile[key]) : "";
  if (machine.reachability !== "live") return { label: t("等待主机连接") };
  if (profile.source === "host") return { label: t("使用自装 Codex，不参与托管切换") };
  if (!target || !verified) return { label: t("目标待验证") };
  if (machine.compatibility === "compatible" && matchesRuntimeTarget(machine, target, schemaHash)) return { label: t("已运行当前托管目标") };

  if (value("runtimeUpdateTarget") === target) {
    const phase = value("runtimeUpdateState");
    if (phase === "failed" || phase === "rolled_back") return { label: phase === "rolled_back" ? t("本机更新失败，已保留回退版本") : t("本机更新未完成，原运行时保留"), error: value("runtimeUpdateError"), failed: true };
    if (phase === "waiting_for_idle") return { label: t("等待任务或通话结束") };
    if (phase === "preparing") return { label: t("后台准备新运行时，可继续工作") };
    if (phase === "activating") return { label: t("正在切换已验证的运行时") };
    if (phase === "validating_runtime") return { label: t("正在本机验证新运行时") };
  }
  const agentPhase = value("agentUpdateState");
  if (pendingAgentTarget(value("agentUpdateTarget"), machine.agentVersion)) {
    if (["failed", "rolled_back"].includes(agentPhase)) return { label: t("连接服务更新未完成"), error: value("agentUpdateError"), failed: true };
    if (["rollout_wait", "downloading", "prepared", "waiting_for_idle", "installing", "preparing", "staged", "restarting", "verifying"].includes(agentPhase)) {
      return { label: agentPhase === "waiting_for_idle" ? t("连接服务等待任务或通话结束后更新") : t("先更新连接服务") };
    }
  }
  if (machine.codexVersion === target) return { label: t("等待主机核验") };
  if (machine.capacity === "busy" || machine.capacity === "saturated") return { label: t("等待当前任务结束后更新") };
  return { label: t("等待主机检查更新") };
}
