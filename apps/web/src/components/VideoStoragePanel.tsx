import { useEffect, useState } from "react";
import { api, type VideoObject, type VideoStoragePage } from "../lib/api";
import { t, locale, systemText } from "../i18n";
import { imageSpace } from "../lib/image-space";

export function VideoStoragePanel() {
  const [page, setPage] = useState<VideoStoragePage>();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<VideoObject>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setPage(undefined); setSelected(undefined); setError("");
    void api.videoStorage(cursors.at(-1), controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(systemText((reason as Error).message)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cursors, revision]);
  async function download(item: VideoObject) {
    if (busy) return;
    setBusy(true); setError("");
    try { const result = await api.downloadVideo(item.key); const link = document.createElement("a"); link.href = result.url; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer"; link.click(); }
    catch (reason) { setError(systemText((reason as Error).message)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try { await api.deleteVideo(selected); setSelected(undefined); setNotice(t("视频已删除。磁盘空间由存储服务稍后回收。")); setRevision(value => value + 1); }
    catch (reason) { setError(systemText((reason as Error).message)); }
    finally { setBusy(false); }
  }
  return <section className="settings-block video-storage-panel" aria-labelledby="video-storage-title">
    <header><h2 id="video-storage-title">{t("视频存储")}</h2><button type="button" className="button button--quiet" disabled={busy || loading} onClick={() => { setCursors([undefined]); setNotice(""); }}>{t("刷新")}</button></header>
    <p className="subtle">{t("管理当前工作区的 Grok 视频输出。原生会话、项目文件及分镜图片不受删除操作影响。")}</p>
    {loading && <p role="status">{t("正在读取视频…")}</p>}
    {page && !page.configured && <p>{t("此工作区尚未配置视频存储")}</p>}
    {page?.configured && <>
      <p>{page.label} · {t("存储上限 {0}", imageSpace(page.quotaBytes ?? 0))}</p>
      <p className="subtle">{t("仅手动删除，不自动清理。单机存储没有冗余副本，重要成片请另行备份。")}</p>
      {page.items.length === 0 && <p>{t("本页暂无视频文件")}</p>}
      <ul className="video-storage-list">{page.items.map(item => <li key={item.key}>
        <div><strong>{item.key.split("/").at(-1)}</strong><small>{item.key}</small><small>{imageSpace(item.bytes)} · {item.modifiedAt ? new Date(item.modifiedAt).toLocaleString(locale()) : t("时间未记录")}</small></div>
        <div className="video-storage-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={() => void download(item)}>{t("下载")}</button>
          <button type="button" className="button button--quiet" disabled={busy || !item.canDelete} title={!item.canDelete ? t("文件刚写入，请一分钟后刷新再删除") : undefined} onClick={() => { setSelected(item); setNotice(""); }}>{t("删除")}</button></div>
      </li>)}</ul>
      <nav className="video-storage-actions" aria-label={t("视频分页")}>
        <button type="button" className="button button--quiet" disabled={busy || cursors.length <= 1} onClick={() => setCursors(items => items.slice(0, -1))}>{t("上一页")}</button>
        <span>{t("第 {0} 页", cursors.length)}</span>
        <button type="button" className="button button--quiet" disabled={busy || !page.nextCursor} onClick={() => { if (page.nextCursor) setCursors(items => [...items, page.nextCursor!]); }}>{t("下一页")}</button>
      </nav>
    </>}
    {selected && <div className="video-storage-confirm" role="alertdialog" aria-labelledby="video-delete-title" aria-describedby="video-delete-description">
      <h3 id="video-delete-title">{t("确认永久删除视频？")}</h3><p className="video-storage-key">{selected.key}</p>
      <p id="video-delete-description">{t("删除后无法恢复，原播放和下载链接将失效。已下载的本地副本仍保留。")}</p>
      <div className="video-storage-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={() => setSelected(undefined)}>{t("取消")}</button><button type="button" className="button button--primary" disabled={busy} onClick={() => void remove()}>{busy ? t("正在删除…") : t("确认删除")}</button></div>
    </div>}
    {error && <p role="alert" className="catalog-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
