import { useState } from "react";
import { Copy, RotateCcw } from "lucide-react";
import type { Machine } from "../lib/types";
import { t } from "../i18n";

export function recoveryPlatform(os: string): "windows" | "macos" | "linux" {
  return /win32|windows/i.test(os) ? "windows" : /darwin|macos|mac os/i.test(os) ? "macos" : "linux";
}

export function repairCommand(machine: Pick<Machine, "os">, origin: string): string {
  const base = new URL(origin).origin;
  const platform = recoveryPlatform(machine.os);
  if (platform === "windows") {
    const url = base.replaceAll("'", "''");
    return `& { $ErrorActionPreference='Stop'; $i=Join-Path $env:TEMP ('agentfleet-repair-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest '${url}/install.ps1' -OutFile $i -TimeoutSec 60; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $i -Mode Repair -Url '${url}'; if ($LASTEXITCODE -ne 0) { throw 'AgentFleets repair failed. See the error above.' } } finally { Remove-Item -LiteralPath $i -ErrorAction SilentlyContinue } }`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `( f=$(mktemp) || exit 1; trap 'rm -f "$f"' EXIT; curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 ${quote(`${base}/${platform === "macos" ? "install-macos" : "install"}`)} -o "$f" && sh "$f" --repair --url ${quote(base)} )`;
}

export function HostRecovery({ machine }: { machine: Machine }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const platform = recoveryPlatform(machine.os);
  const command = repairCommand(machine, location.origin);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setError(""); }
    catch { setError(t("复制失败，请手动选中命令复制")); }
  }
  return <section className="settings-block host-recovery" aria-label={t("恢复主机连接")}>
    <div className="host-recovery__heading"><RotateCcw size={23} /><div><h2>{t("恢复主机连接")}</h2><p>{t("主机不可达时，在主机本地重置 AgentFleets 连接服务。")}</p></div></div>
    <p>{t("关闭面板不影响主机连接。主机开机、联网并登录安装时的系统账号后，应自动恢复连接；持续无法连接时再使用下方修复命令。")}</p>
    <ol><li>{t("先确认主机已开机并联网，登录安装 AgentFleets 时使用的系统账号。")}</li><li>{platform === "windows" ? t("在该主机打开 PowerShell，粘贴下方命令并执行。") : t("在该主机打开终端，粘贴下方命令并执行。")}</li><li>{t("执行完成后，面板收到主机连接会自动更新状态。")}</li></ol>
    <p className="subtle">{t("命令会下载连接服务并重新注册、启动后台服务，保留配对、项目和会话数据。若主机仍有任务运行，请先等待任务结束。")}</p>
    <div className="host-recovery__command"><span>{platform === "windows" ? "Windows · PowerShell" : platform === "macos" ? "macOS · Terminal" : "Linux · Terminal"}</span><pre tabIndex={0} aria-label={t("连接修复命令")}><code>{command}</code></pre></div>
    <div className="host-recovery__footer"><button type="button" className="button button--primary" onClick={() => void copy()}><Copy size={16} />{copied ? t("已复制，到主机执行") : t("复制修复命令")}</button><span>{t("主机离线时，网页无法代替你在主机执行命令。")}</span></div>
    {copied && <p role="status">{t("命令已复制，尚未执行修复。请到对应主机粘贴运行。")}</p>}
    {error && <p className="catalog-error" role="alert">{error}</p>}
  </section>;
}
