import { t } from "../i18n";
import type { Machine } from "../lib/types";

export function HostUpdateStatus({machine}: {machine: Pick<Machine, "agentVersion" | "reachability" | "codexProfile">}) {
  const profile = machine.codexProfile ?? {};
  const value = (key: string) => typeof profile[key] === "string" ? String(profile[key]) : "";
  const phase = value("agentUpdateState");
  const labels: Record<string,string> = {
    rollout_wait:t("新版正在分批发布，尚未轮到本机"), downloading:t("正在下载与校验"), prepared:t("新版已准备，等待切换"), waiting_for_idle:t("等待任务或通话结束"),
    installing:t("正在安装"), preparing:t("正在准备升级"), staged:t("已安装，等待启动"), restarting:t("正在重启连接服务"),
    verifying:t("正在确认连接与运行健康"), succeeded:t("升级完成，健康检查通过"),
    rolled_back:value("agentUpdateVerifiedAt") ? t("升级失败，旧版已恢复连接") : t("已回退，等待确认旧版连接"), failed:t("更新未完成"), current:t("当前版本已是最新"),
  };
  return <div className="host-update-status" aria-live="polite">
    <dl><div><dt>{t("实际运行版本")}</dt><dd>{machine.agentVersion}</dd></div>
      <div><dt>{t("已安装版本")}</dt><dd>{value("agentInstalledVersion") || t("等待主机报告")}</dd></div>
      {value("agentUpdateTarget") && <div><dt>{t("本次更新目标")}</dt><dd>{value("agentUpdateTarget")}</dd></div>}
    </dl>
    {phase && <p><strong>{labels[phase] || t("等待主机核验")}</strong></p>}
    {value("agentUpdateError") && <p className="catalog-error">{value("agentUpdateError")}</p>}
    {value("agentRollbackVersion") && <small>{t("保留回退版本")} · {value("agentRollbackVersion")}</small>}
    {machine.reachability !== "live" && <p className="subtle">{t("主机离线，以上为最后上报状态，尚未确认当前版本。")}</p>}
  </div>;
}
