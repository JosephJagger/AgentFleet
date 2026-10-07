import { useEffect, useRef, useState } from "react";
import { Folder, FileText, RefreshCw } from "lucide-react";
import { t, systemText } from "../i18n";
import { useCodexOperation } from "./useCodexOperation";
import type { FleetSession, CommandReceipt } from "../lib/types";

export function ProjectFilesPanel(props: { session: FleetSession; commands: CommandReceipt[]; onChanged: () => void }) {
  const op = useCodexOperation(props);
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState("");
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [revision, setRevision] = useState("");
  const [loadedPath, setLoadedPath] = useState("");
  const [requestPath, setRequestPath] = useState("");
  const [destination, setDestination] = useState("");
  const [action, setAction] = useState("files.write");
  const [confirmed, setConfirmed] = useState(false);
  const [backup, setBackup] = useState("");
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!op.result || !op.id || applied.current === op.id) return;
    applied.current = op.id;
    if (op.result?.operation === "files.read" && op.result.status === "available") {
      setText(op.result.rows.filter(r => r.name.startsWith("content:")).map(r => r.detail).join(""));
      setSavedText(op.result.rows.filter(r => r.name.startsWith("content:")).map(r => r.detail).join(""));
      setRevision(op.result.rows.find(r => r.name === "revision")?.detail ?? ""); setLoadedPath(requestPath); setConfirmed(false);
    } else if (op.result?.operation === "files.write" && op.result.status === "completed") {
      setSavedText(text);
      setRevision(op.result.rows.find(r => r.name === "revision")?.detail ?? ""); setConfirmed(false);
    } else if (op.result?.operation === "files.remove" && op.result.status === "completed") { setRevision(""); setLoadedPath(""); setConfirmed(false); }
  }, [op.result]);
  const read = (value: string) => { if (text !== savedText && !window.confirm(t("读取文件会替换未保存的编辑，是否继续？"))) return; setPath(value); setRequestPath(value); void op.run("files.read", { path: value }); };
  const blocked = op.pending || !op.allowed;
  return <section className="project-files stack-form" aria-label={t("项目文件")}>
    <p>{t("浏览项目文件，或编辑 48 KB 以内的 UTF-8 文本。保存保留备份，删除移入项目回收站。")}</p>
    <div className="workspace-actions"><label>{t("目录")}<input value={directory} disabled={op.pending} placeholder="." onChange={e => setDirectory(e.target.value)} /></label><button type="button" className="button button--quiet" disabled={blocked} onClick={() => void op.run("files.list", directory ? { path: directory } : {})}><RefreshCw size={16}/>{t("浏览")}</button><button type="button" className="button button--quiet" disabled={blocked} onClick={() => void op.run("files.trash")}>{t("回收站与备份")}</button></div>
    {op.result?.operation === "files.list" && <div className="workspace-file-list">{op.result.rows.map(row => <button type="button" key={row.detail} disabled={blocked || row.status === "其他类型"} onClick={() => { if (row.status === "目录") { setDirectory(row.detail); void op.run("files.list", { path: row.detail }); } else read(row.detail); }}>{row.status === "目录" ? <Folder size={17}/> : <FileText size={17}/>}<span>{row.name}</span></button>)}{op.result.nextCursor && <button type="button" disabled={blocked} onClick={() => void op.run("files.list", { ...(directory ? { path: directory } : {}), cursor: op.result!.nextCursor })}>{t("下一页")}</button>}{!op.result.rows.length && <p>{t("目录为空")}</p>}</div>}
    {op.result?.operation === "files.trash" && <label>{t("选择备份")}<select value={backup} onChange={e => { setBackup(e.target.value); setAction("files.restore"); setConfirmed(false); }}><option value="">{t("请选择")}</option>{op.result.rows.map(row => <option key={row.name} value={row.name}>{row.detail} · {new Date(Number(row.name.split("-")[0])).toLocaleString()}</option>)}</select></label>}
    <div className="workspace-actions"><label>{t("项目内文件路径")}<input value={path} disabled={op.pending} onChange={e => { setPath(e.target.value); setConfirmed(false); }} placeholder="src/example.ts" /></label><button type="button" className="button button--quiet" disabled={blocked || !path} onClick={() => read(path)}>{t("读取文件")}</button></div>
    {path && <a className="button button--quiet" target="_blank" rel="noopener noreferrer" href={`/api/sessions/${encodeURIComponent(props.session.id)}/files?path=${encodeURIComponent(path)}&download=1`}>{t("下载文件")}</a>}
    <label>{t("文件内容")}<textarea className="workspace-editor" spellCheck={false} value={text} maxLength={48000} disabled={op.pending} onChange={e => { setText(e.target.value); setConfirmed(false); }} /></label>
    <label>{t("文件操作")}<select value={action} disabled={op.pending} onChange={e => { setAction(e.target.value); setConfirmed(false); }}><option value="files.write">{t("保存修改")}</option><option value="files.create">{t("新建文件")}</option><option value="files.mkdir">{t("新建目录")}</option><option value="files.copy">{t("复制文件")}</option><option value="files.remove">{t("移入回收站")}</option><option value="files.restore">{t("恢复备份到新文件")}</option></select></label>
    {["files.copy", "files.restore"].includes(action) && <label>{t("新文件路径（不覆盖已有文件）")}<input value={destination} disabled={op.pending} onChange={e => { setDestination(e.target.value); setConfirmed(false); }} /></label>}
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} disabled={op.pending} onChange={e => setConfirmed(e.target.checked)} />{t("确认对以上文件执行所选操作")}</label>
    <button type="button" className="button button--primary" disabled={blocked || !confirmed || (action === "files.restore" ? !backup || !destination : !path) || ["files.write", "files.copy", "files.remove"].includes(action) && (!revision || loadedPath !== path)} onClick={() => void op.run(action, { confirmed: true, ...(action === "files.restore" ? { backup, destination } : { path }), ...(["files.write", "files.create"].includes(action) ? { text } : {}), ...(["files.write", "files.copy", "files.remove"].includes(action) ? { revision } : {}), ...(action === "files.copy" ? { destination } : {}) })}>{op.pending ? t("等待主机回执") : t("执行文件操作")}</button>
    {!op.allowed && <p>{t("请连接主机并接管会话后使用。")}</p>}{op.error && <p role="alert">{systemText(op.error)}</p>}
    {op.result && !["files.read", "files.list", "files.trash"].includes(op.result.operation) && <div role="status">{op.result.rows.map(r => <p key={r.name}>{r.status} · {r.detail}</p>)}</div>}
  </section>;
}
