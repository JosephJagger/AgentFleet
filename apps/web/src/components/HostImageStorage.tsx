import { t, locale, systemText } from "../i18n";
import { imageSpace } from "../lib/image-space";
import { useCallback, useEffect, useState } from "react";
import { Paperclip, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { CloudImageUsage } from "../lib/types";
import { SessionImageStorage } from "./SessionImageStorage";
import { HostDisclosure } from "./HostDisclosure";


export function HostImageStorage({ machineId, name }: { machineId: string; name: string }) {
  const [usage, setUsage] = useState<CloudImageUsage>();
  const [error, setError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const next = await api.machineImages(machineId, signal); if (!signal?.aborted) { setUsage(next); setError(""); } }
    catch (reason) { if (!signal?.aborted) setError((reason as Error).message); }
  }, [machineId]);
  useEffect(() => {
    const controller = new AbortController(); const reload = () => { void refresh(controller.signal); };
    reload(); window.addEventListener("focus", reload); const timer = window.setInterval(reload, 15_000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", reload); };
  }, [refresh]);
  const description = usage
    ? t("{0} 张图片 · 云端 {1} / {2}", usage.imageCount, imageSpace(usage.usedBytes), imageSpace(usage.quotaBytes))
    : t("查看用量并按会话清理附件");
  return <HostDisclosure className={`host-storage-disclosure host-storage-disclosure--${usage?.level ?? "normal"}`} title={t("附件存储与清理")} description={description} icon={<Paperclip size={21} />}>
    <section className={`host-image-storage host-image-storage--${usage?.level ?? "normal"}`} aria-label={t("附件存储与清理")}>
    <header><div className="host-image-storage__title"><div><h2>{t("存储用量")}</h2><p>{name} {locale() === "en" ? " " : ""}{t("· 图片使用云端配额，文件暂存在主机项目中")}</p></div></div>
      <button type="button" className="icon-button" aria-label={t("刷新附件用量")} onClick={() => void refresh()}><RefreshCw size={16} /></button></header>
    {usage ? <><div className="host-image-storage__usage"><strong>{imageSpace(usage.usedBytes)}</strong><span>/ {imageSpace(usage.quotaBytes)}</span><small>{usage.imageCount} {locale() === "en" ? " " : ""}{t("张图片 · 相同图片不重复占用配额")}</small><small>{usage.fileCount} {locale() === "en" ? " " : ""}{t("个主机暂存文件 · {0}", imageSpace(usage.fileBytes))}</small></div>
      {!!usage.fileTypes?.length && <div className="attachment-type-summary">{usage.fileTypes.map(item => <span key={item.type}><b>{item.type}</b> {item.count} · {imageSpace(item.bytes)}</span>)}</div>}
      <progress aria-label={t("云端图片空间使用量")} max={usage.quotaBytes} value={Math.min(usage.usedBytes, usage.quotaBytes)} />
      {usage.level !== "normal" && <p className="host-image-storage__warning" role="alert">{usage.level === "full" ? t("云端图片空间已达到 {0}，已暂停接收新图片。请清理后继续；文字消息不受影响。", imageSpace(usage.quotaBytes)) : t("云端图片空间使用量已达到 80%，接近 {0} 上限，请及时清理。", imageSpace(usage.quotaBytes))}</p>}
      <p className="subtle">{t("在下方选择会话并预览，核验后清理对应的主机暂存文件、宿主机图片和云端引用。")}</p>
      {usage.pendingImageCommands > 0 && <p className="subtle">{t("还有")}{locale() === "en" ? " " : ""}{usage.pendingImageCommands} {locale() === "en" ? " " : ""}{t("条图片消息在排队、传输或等待结果核验，对应会话暂不能清理。")}</p>}
    </> : <p className="subtle">{t("正在读取图片空间…")}</p>}
    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    </section><SessionImageStorage key={machineId} machineId={machineId} />
  </HostDisclosure>;
}
