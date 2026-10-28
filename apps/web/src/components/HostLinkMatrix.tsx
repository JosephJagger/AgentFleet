import { LoaderCircle, PlugZap } from "lucide-react";
import { useId } from "react";
import { displayName } from "../lib/display-name";
import { locale, t } from "../i18n";
import type { SshLinkMatrix, SshMatrixSource } from "../lib/types";

const REASONS: Record<string, string> = {
  disabled: "账号已停用",
  not_allowed: "未授权该主机访问",
  target_unsupported: "目标主机不可用或系统不支持",
  no_address: "没有可用地址",
  jump_missing: "跳板机账号不可用",
  routes_unsupported: "需更新连接服务以支持跳板",
  source_platform: "该系统不支持 SSH 互通",
  agent_outdated: "需更新连接服务",
  relay_disabled: "面板中转未启用",
  relay_unsupported: "需更新连接服务以支持中转",
  host_key_unpinned: "目标主机指纹未固定，中转需要先固定",
};
const reasonText = (reason?: string) => (reason && REASONS[reason] ? t(REASONS[reason]!) : "");

function Cell({ source, route }: { source: SshMatrixSource; route: string }) {
  const detail = [reasonText(source.reason), source.error, source.testedAt && t("测试于 {0}", new Date(source.testedAt).toLocaleString(locale()))].filter(Boolean).join(" · ");
  if (source.state === "ok") return <td><span className="ssh-check ssh-check--ok" title={detail}>{source.path === "proxyjump" ? t("经跳板 ✓") : source.path === "relay" ? t("经中转 ✓") : t("直连 ✓")}</span></td>;
  if (source.state === "failed") return <td><span className="ssh-check ssh-check--bad" title={detail}>{t("连接失败")}</span>{source.error && <small>{source.error}</small>}</td>;
  if (source.state === "untested") return <td><span className="ssh-check ssh-check--unknown">{source.via ? t("未测试（经跳板）") : route === "relay" ? t("未测试（经中转）") : route === "auto" ? t("未测试（直连或中转）") : t("未测试")}</span>{source.agent === "offline" && <small>{t("主机离线")}</small>}</td>;
  return <td><span className="ssh-check ssh-check--unknown">{source.state === "excluded" ? t("不下发") : t("不支持")}</span><small>{reasonText(source.reason)}</small></td>;
}

/** Rows are the accounts being reached, columns are the hosts that connect; each cell is that pair's real, tested state. */
export function HostLinkMatrix({ matrix, canManage, busy, onTestAll }: { matrix: SshLinkMatrix; canManage: boolean; busy: boolean; onTestAll: () => void }) {
  const heading = useId();
  if (!matrix.links.length) return null;
  const routeText = (link: SshLinkMatrix["links"][number]) => link.route === "proxyjump"
    ? t("经 {0} 跳转", displayName(matrix.hosts.find(host => host.machineId === link.proxyJumpMachineId)?.name ?? ""))
    : link.route === "relay" ? t("经面板中转") : link.route === "auto" ? t("自动（直连优先）") : t("直连");
  return <section className="host-links" aria-labelledby={heading}>
    <div className="host-ssh__heading"><div><h3 id={heading}>{t("互通矩阵")}</h3><p>{t("行是被访问的账号，列是发起连接的主机；状态来自真实的连接测试。")}</p></div>
      {canManage && <button type="button" className="button button--quiet" disabled={busy} onClick={onTestAll}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}{t("测试全部")}</button>}</div>
    <div className="host-links__scroll"><table>
      <thead><tr><th scope="col">{t("被访问的账号")}</th>{matrix.hosts.map(host => <th scope="col" key={host.machineId}>{displayName(host.name)}</th>)}</tr></thead>
      <tbody>{matrix.links.map(link => <tr key={link.accountId}>
        <th scope="row"><code>{link.alias}</code><small>{displayName(link.targetName)} · {routeText(link)}{!link.enabled && ` · ${t("已停用")}`}</small></th>
        {matrix.hosts.map(host => {
          if (host.machineId === link.targetMachineId) return <td key={host.machineId} className="host-links__self" aria-label={t("目标主机自身")}>—</td>;
          const source = link.sources.find(item => item.machineId === host.machineId);
          return source ? <Cell key={host.machineId} source={source} route={link.route} /> : <td key={host.machineId}>—</td>;
        })}
      </tr>)}</tbody>
    </table></div>
  </section>;
}
