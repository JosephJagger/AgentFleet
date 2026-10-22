import { LoaderCircle, Waypoints } from "lucide-react";
import { useState } from "react";
import { systemText, t } from "../i18n";
import { api } from "../lib/api";
import type { SshRelaySettings } from "../lib/types";

/**
 * The workspace switch for carrying SSH through the panel when two hosts cannot reach each other.
 * It is off by default, and everyone can see its state; only the platform administrator can change it.
 */
export function HostRelaySettings({ settings, canManage, onSaved }: { settings: SshRelaySettings; canManage: boolean; onSaved: (settings: SshRelaySettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    const enable = !settings.enabled;
    const warning = enable
      ? t("启用后，被设置为「面板中转」或「自动」的账号，在主机之间无法直连时会经面板转发 SSH 数据。数据仍由 SSH 端到端加密，面板看不到内容；但会经过面板服务器和面板域名。确定启用？")
      : t("关闭后，正在经面板中转的连接会立即断开，相关账号不再下发给主机。确定关闭？");
    if (!window.confirm(warning)) return;
    setBusy(true); setError("");
    try { onSaved(await api.saveSshRelay({ enabled: enable, revision: settings.revision })); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="host-relay" aria-labelledby="host-relay-title">
    <div className="host-ssh__heading"><div>
      <h3 id="host-relay-title"><Waypoints size={16} aria-hidden="true" /> {t("面板中转")} <span className={`ssh-check ssh-check--${settings.enabled ? "ok" : "unknown"}`}>{settings.enabled ? t("已启用") : t("未启用")}</span></h3>
      <p>{t("主机之间连不通（例如在 NAT 后面）时，让 SSH 数据经面板转发。默认关闭；只能转发到目标主机本机的 SSH 服务。")}</p></div>
      {canManage && <button type="button" className="button button--quiet" disabled={busy} onClick={() => void toggle()}>{busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}{settings.enabled ? t("关闭面板中转") : t("启用面板中转")}</button>}</div>
    <ul className="host-help host-relay__notes">
      <li>{t("必须先固定目标主机的指纹，否则不会下发。")}</li>
      <li>{t("连接断开后 {0} 秒内重连可自动续传；面板更新会等待正在进行的中转连接结束。", String(settings.limits.resumeGraceSeconds))}</li>
      <li>{t("每台主机最多 {0} 条、目标主机最多 {1} 条、工作区最多 {2} 条中转连接。", String(settings.limits.perSource), String(settings.limits.perTarget), String(settings.limits.perWorkspace))}</li>
      <li>{t("中转流量经过面板域名；若该域名使用了 CDN 或代理服务，请确认其服务条款允许转发 SSH 数据。")}</li>
    </ul>
    <p className="host-help" role="status">{t("当前中转连接：{0}", String(settings.active))}</p>
    {!canManage && <p className="host-help">{t("仅平台管理员可以启用或关闭面板中转。")}</p>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
  </section>;
}
