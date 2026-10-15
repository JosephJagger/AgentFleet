import { t, locale } from "../i18n";
import type { Machine, HostOperation } from "../lib/types";

export type AgentReleaseStatus = {status:string;expectedVersion:string|null;publicVersion:string|null;checkedAt:string};
export function HostUpdateStatus({machine, operations=[], release, compact=false}: {machine: Pick<Machine, "agentVersion" | "reachability" | "codexProfile">;operations?:HostOperation[];release?:AgentReleaseStatus; compact?:boolean}) {
  const profile = machine.codexProfile ?? {};
  const value = (key: string) => typeof profile[key] === "string" ? String(profile[key]) : "";
  const latest = operations.filter(o=>o.type==="agent.update").sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
  const recent = latest && (!value("agentUpdateCheckedAt") || Date.parse(latest.updatedAt)>=Date.parse(value("agentUpdateCheckedAt")));
  const reportedPhase = recent ? latest.state==="succeeded" ? String(latest.result?.phase ?? "checked") : latest.state : value("agentUpdateState");
  const phase = ["restarting", "staged", "installing"].includes(reportedPhase) && machine.agentVersion === value("agentUpdateTarget") && !value("agentUpdateVerifiedAt") ? "verification_pending" : reportedPhase;
  const active = ["rollout_wait","downloading","prepared","waiting_for_idle","installing","preparing","staged","restarting","verifying","accepted","running"].includes(phase);
  const labels: Record<string,string> = {
    verification_pending:t("已运行目标版本，升级健康回执待核验"),
    accepted:t("等待主机"), running:t("正在检查更新"), checked:t("检查完成"), unknown:t("结果待核验"), expired:t("操作已过期"),
    rollout_wait:t("新版正在分批发布，尚未轮到本机"), downloading:t("正在下载与校验"), prepared:t("新版已准备，等待切换"), waiting_for_idle:t("等待任务或通话结束"),
    installing:t("正在安装"), preparing:t("正在准备升级"), staged:t("已安装，等待启动"), restarting:t("正在重启连接服务"), verifying:t("正在确认连接与运行健康"),
    rolled_back:value("agentUpdateVerifiedAt") ? t("升级失败，旧版已恢复连接") : t("已回退，等待确认旧版连接"), failed:t("更新未完成"), current:t("检查完成，更新源未提供更高版本"),
  };
  const status = release?.status==="mismatch" ? t("更新源不一致，暂无法确认最新版本") : release?.status!=="ready" ? t("暂无法确认最新版本") : machine.agentVersion===release.publicVersion ? t("当前运行版本与发布版本一致") : t("运行版本与发布版本不同，请检查更新");
  const installed=value("agentInstalledVersion");
  if (compact) return <p className="subtle">{machine.reachability !== "live" ? t("离线，显示最后上报状态") : phase && labels[phase] ? labels[phase] : status}</p>;
  return <div className="host-update-status" aria-live="polite">
    <dl><div><dt>{t("实际运行版本")}</dt><dd>{machine.agentVersion}</dd></div>
      {installed!==machine.agentVersion && <div><dt>{t("已安装版本")}</dt><dd>{installed || t("等待主机报告")}</dd></div>}
      <div><dt>{t("公网可用版本")}</dt><dd>{release?.publicVersion || t("等待核验")}</dd></div>
      {release?.status==="mismatch" && <div><dt>{t("面板发布目标")}</dt><dd>{release.expectedVersion}</dd></div>}
      {active && value("agentUpdateTarget") && <div><dt>{t("本次更新目标")}</dt><dd>{value("agentUpdateTarget")}</dd></div>}
    </dl>
    <p className={release?.status==="mismatch" ? "catalog-error" : undefined}><strong>{status}</strong></p>
    {phase && phase!=="succeeded" && <p>{labels[phase] || t("等待主机核验")}</p>}
    {latest && <p className="subtle">{t("最近检查")} · {new Date(latest.updatedAt).toLocaleString(locale())}{typeof latest.result?.version==="string" ? ` · ${t("主机返回版本")} ${latest.result.version}` : ""}</p>}
    {(recent ? latest.error?.message : value("agentUpdateError")) && <p className="catalog-error">{recent ? latest.error?.message : value("agentUpdateError")}</p>}
    {(value("agentUpdateVerifiedAt") || value("agentRollbackVersion")) && <details className="host-technical"><summary>{t("上次升级记录")}</summary>
      {value("agentUpdateVerifiedAt") && <p>{t("上次健康核验")} · {new Date(value("agentUpdateVerifiedAt")).toLocaleString(locale())}</p>}
      {value("agentRollbackVersion") && <small>{t("保留回退版本")} · {value("agentRollbackVersion")}</small>}
    </details>}
    {machine.reachability !== "live" && <p className="subtle">{t("主机离线，以上为最后上报状态，尚未确认当前版本。")}</p>}
  </div>;
}
