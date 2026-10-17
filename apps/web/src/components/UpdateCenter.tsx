import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { Dashboard, HostOperation } from "../lib/types";
import { displayName } from "../lib/display-name";
import { runtimeRollout } from "../lib/runtime-rollout";
import { t, systemText } from "../i18n";
import { HostUpdateStatus, type AgentReleaseStatus } from "./HostUpdateStatus";
import { RuntimeReleasePanel } from "./RuntimeReleasePanel";

export function UpdateCenter({ dashboard }: { dashboard: Dashboard }) {
  const [release, setRelease] = useState<AgentReleaseStatus>();
  const [build, setBuild] = useState("");
  const [error, setError] = useState("");
  const [operations, setOperations] = useState<Record<string, HostOperation[]>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const mutations = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  const hosts = dashboard.machines.filter(machine => machine.identity === "paired");
  const hostKey = hosts.map(machine => machine.id).sort().join(",");
  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    const refresh = async () => {
      if (active) return;
      active = true;
      try {
        const next = await api.agentReleaseStatus(controller.signal);
        if (!controller.signal.aborted) { setRelease(next); setError(""); }
        const results = await Promise.all(hostKey.split(",").filter(Boolean).map(async id => [id, await api.hostOperations(id, controller.signal)] as const));
        if (!controller.signal.aborted) setOperations(Object.fromEntries(results));
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("读取升级状态失败")); }
      finally { active = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    if (dashboard.user.platformAdmin) void api.release().then(value => { if (!controller.signal.aborted) setBuild(value.build); }).catch(() => undefined);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [hostKey, dashboard.user.platformAdmin]);
  async function check(id: string) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id); setSubmitting(value => ({ ...value, [id]: true })); setError("");
    const mutation = mutations.current.get(id) ?? crypto.randomUUID();
    mutations.current.set(id, mutation);
    try {
      const operation = await api.hostOperation(id, "agent.update", mutation);
      mutations.current.delete(id);
      setOperations(value => ({ ...value, [id]: [operation, ...(value[id] ?? []).filter(item => item.id !== operation.id)] }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("操作未完成")); }
    finally { inFlight.current.delete(id); setSubmitting(value => ({ ...value, [id]: false })); }
  }
  return <section className="settings-block update-center">
    <header className="config-heading"><h2><Download size={18}/>{t("更新中心")}</h2><p>{t("后台准备，空闲切换。任务和通话继续使用当前版本。")}</p></header>
    <dl className="update-center__summary">
      <div><dt>{t("网页面板")}</dt><dd>{build || t("由管理员发布")}</dd></div>
      <div><dt>{t("连接服务发布版本")}</dt><dd>{release?.publicVersion || t("等待核验")}</dd></div>
      <div><dt>{t("本站托管 Codex 目标")}</dt><dd>{dashboard.compatibilityProfile.managedCodexVersion}</dd></div>
    </dl>
    {error && <p role="alert" className="catalog-error">{systemText(error)}</p>}
    <p className="subtle">{t("离线主机显示最后上报版本；重新连接后自动检查。安装方式不影响后续服务更新。")}</p>
    <div className="update-center__hosts">
      {hosts.map(machine => {
        const history = operations[machine.id] ?? [];
        const pending = history.some(item => item.type === "agent.update" && ["accepted", "running", "unknown"].includes(item.state));
        const runtime = runtimeRollout(machine, dashboard.compatibilityProfile.managedCodexVersion, dashboard.compatibilityProfile.schemaHash, dashboard.compatibilityProfile.validationStatus === "verified");
        return <article key={machine.id} className="update-center__host">
          <header><strong>{displayName(machine.name)}</strong><span>{machine.os} · {t(machine.reachability === "live" ? "在线" : "离线")}</span><button type="button" className="button button--quiet" disabled={Boolean(submitting[machine.id]) || pending || machine.reachability !== "live" || !machine.maintenanceCapabilities?.includes("agent.update") || !dashboard.user.platformAdmin} title={dashboard.user.platformAdmin ? undefined : t("仅平台管理员可更新连接服务")} onClick={() => void check(machine.id)}><RefreshCw size={14}/>{pending ? t("等待主机核验") : t("检查并更新")}</button></header>
          <HostUpdateStatus machine={machine} operations={history} release={release} compact/><div className="update-center__components"><details><summary>{t("连接服务")} <strong>{machine.agentVersion}</strong></summary><HostUpdateStatus machine={machine} operations={history} release={release}/></details>
          <div><p>Codex <strong>{machine.codexVersion || t("尚未上报")}</strong></p>{dashboard.user.platformAdmin && <><small>{runtime.label}</small>{runtime.error && <p className="catalog-error">{systemText(runtime.error)}</p>}</>}</div></div>
        </article>;
      })}
      {!hosts.length && <p>{t("添加主机并连接后，可在这里查看更新进度。")}</p>}
    </div>
    {dashboard.user.platformAdmin && <RuntimeReleasePanel/>}
  </section>;
}
