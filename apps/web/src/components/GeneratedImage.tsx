import { useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { t } from "../i18n";
import { isGeneratedImage } from "../lib/generated-images";
import type { TimelineEvent } from "../lib/types";
import "./generated-image.css";

export function GeneratedImage({ event }: { event: TimelineEvent }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failedSource, setFailedSource] = useState<string>();
  if (event.payloadState === "deleted" || event.payloadState === "suppressed") return null;
  const url = event.images?.find(isGeneratedImage);
  const available = url && failedSource !== url;
  const extension = url?.startsWith("data:image/jpeg;") ? "jpg" : url?.startsWith("data:image/webp;") ? "webp" : "png";
  if (!available) return <p className="generated-image__status" role="status">{
    event.status === "in_progress" ? t("正在生成图片…")
      : event.status === "failed" ? t("图片生成失败")
      : event.body || t("图片暂不可用，原图可能已移动、清理或超出同步大小限制。")
  }</p>;
  return <figure className="generated-image">
    <button className="generated-image__open" type="button" aria-label={t("放大生成的图片")} onClick={() => dialog.current?.showModal()}>
      <img src={url} alt={t("生成的图片")} loading="lazy" onError={() => setFailedSource(url)} />
    </button>
    <figcaption><span>{t("生成的图片")}</span><a href={url} download={`generated-image.${extension}`}><Download size={14} aria-hidden="true" />{t("下载图片")}</a></figcaption>
    <dialog ref={dialog} className="image-lightbox" aria-label={t("图片预览")} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <button type="button" className="button" aria-label={t("关闭图片预览")} onClick={() => dialog.current?.close()}><X size={18} /></button>
      <img src={url} alt={t("图片放大预览")} />
    </dialog>
  </figure>;
}
