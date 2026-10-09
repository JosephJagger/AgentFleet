import { api } from "../lib/api";
import { Children, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Download, Eye } from "lucide-react";
import { t, useLocale } from "../i18n";
import "./markdown-message.css";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error("copy failed");
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const props = isValidElement<{ children?: ReactNode; className?: string }>(code) ? code.props : {};
  const text = typeof props.children === "string" ? props.children : "";
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1];
  const [copiedText, setCopiedText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const copied = copiedText === text;
  async function copy() {
    try { await copyText(text); setCopiedText(text); setFailed(false); }
    catch { setFailed(true); }
  }
  return <div className="markdown-code">
    <div className="markdown-code__header"><span>{language || t("代码")}</span><button type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制代码")}</button></div>
    {failed && <span className="markdown-code__notice" role="status">{t("复制失败，请手动选择代码复制。")}</span>}
    <pre tabIndex={0} aria-label={t("代码")}>{children}</pre>
  </div>;
}

function hostFilePath(href: string): string | undefined {
  try {
    if (href.startsWith("file://")) {
      const url = new URL(href);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      const path = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path;
    }
    const decoded = decodeURI(href);
    if (decoded.startsWith("/") && !decoded.startsWith("//")) return decoded;
    if (/^[A-Za-z]:[\\/]/u.test(decoded)) return decoded;
    if (decoded && !decoded.startsWith("#") && !decoded.startsWith("?") && !decoded.startsWith("//") && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)) return decoded;
  } catch { /* Invalid encoded paths remain inert. */ }
  return undefined;
}

function fileUrl(sessionId: string, path: string, download = false): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

// Codex emits file citations as directives in assistant prose. Convert only
// Markdown text nodes, leaving fenced/inline code and copied replies intact.
function remarkFileCitations() {
  type Node = { type?: string; value?: string; children?: Node[]; url?: string };
  const citation = /:codex-file-citation\{([^{}]*)\}/gu;
  function visit(node: Node): void {
    if (!node.children || ["link", "linkReference", "image", "code", "inlineCode"].includes(node.type ?? "")) return;
    const children: Node[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || typeof child.value !== "string") {
        visit(child);
        children.push(child);
        continue;
      }
      let start = 0;
      for (const match of child.value.matchAll(citation)) {
        const attribute = /(?:^|\s)path="((?:\\.|[^"\\])*)"/u.exec(match[1] ?? "");
        const path = attribute?.[1]?.replace(/\\(["\\])/gu, "$1");
        if (!path || !hostFilePath(path)) continue;
        if (match.index > start) children.push({ type: "text", value: child.value.slice(start, match.index) });
        const filename = path.split(/[\\/]/u).at(-1) || path;
        children.push({ type: "link", url: path, children: [{ type: "text", value: filename }] });
        start = match.index + match[0].length;
      }
      if (start < child.value.length) children.push({ type: "text", value: child.value.slice(start) });
    }
    node.children = children;
  }
  return (tree: unknown) => visit(tree as Node);
}

/** Recognize explicit file references in prose; commands and fenced examples stay untouched. */
function remarkHostFilePaths() {
  type Node = {type?:string;value?:string;children?:Node[];url?:string};
  const inlinePath=(value:string):string|undefined=>{
    const path=value.replace(/:\d+(?::\d+)?$/u, "");
    if(!/^(?:\/(?!\/)|[A-Za-z]:[\\/]|\.{1,2}[\\/]|[A-Za-z0-9_@.-]+[\\/])/u.test(path) || /[\r\n<>|]/u.test(path) || !/[^\\/]\.[A-Za-z0-9]{1,16}$/u.test(path))return undefined;
    return hostFilePath(path);
  };
  const prosePath=/(^|[\s（(【[“"'：:，,。;；])((?:\/(?!\/)|[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s<>"'`，。；：！？、（）【】()\[\]{}]+\.[A-Za-z0-9]{1,16})(?=$|[\s，。；：！？、（）【】()\[\]{}.,;:"'”])/gu;
  function visit(node:Node):void {
    if(!node.children || ["link","linkReference","image","code"].includes(node.type ?? ""))return;
    const children:Node[]=[];
    for(const child of node.children){
      if(child.type === "inlineCode" && typeof child.value === "string") {
        const path=inlinePath(child.value);
        children.push(path?{type:"link",url:path,children:[child]}:child);
      }else if(child.type === "text" && typeof child.value === "string") {
        let start=0;
        for(const match of child.value.matchAll(prosePath)) {
          const path=inlinePath(match[2]!);if(!path)continue;
          const index=match.index+match[1]!.length;
          if(index>start)children.push({type:"text",value:child.value.slice(start,index)});
          children.push({type:"link",url:path,children:[{type:"inlineCode",value:match[2]}]});
          start=index+match[2]!.length;
        }
        if(start<child.value.length)children.push({type:"text",value:child.value.slice(start)});
      }else {visit(child);children.push(child);}
    }
    node.children=children;
  }
  return (tree:unknown)=>visit(tree as Node);
}

function LocalFileLink({ sessionId, path, children }: { sessionId: string; path: string; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outside, setOutside] = useState(false);
  const [delivered, setDelivered] = useState<string>();
  async function read(download: boolean) {
    if (busy) return;
    setBusy(true); setError(""); setOutside(false);
    const preview = !download ? window.open("about:blank", "_blank") : null;
    if (preview) preview.opener = null;
    try {
      const response = await fetch(fileUrl(sessionId, delivered ?? path, download), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const code = body.error?.code;
        setOutside(code === "FILE_OUTSIDE_PROJECT");
        const messages: Record<string, string> = {
          FILE_OUTSIDE_PROJECT: "文件保存在项目外。可将此文件复制到项目内交付，原文件会保留。",
          FILE_NOT_FOUND: "文件已移动或删除，请在会话中重新准备交付文件。",
          FILE_HOST_UNAVAILABLE: "主机暂不可用，请连接主机后重试。",
          FILE_TOO_LARGE: "文件超过 50 MiB，请压缩或拆分后下载。",
          FILE_TRANSFER_TIMEOUT: "文件传输超时，请检查主机连接后重试。",
        };
        throw new Error(t(messages[code] ?? "文件读取失败，请检查主机和文件状态后重试。") + (code ? ` (${code})` : ""));
      }
      const blob = await response.blob();
      const expected = response.headers.get("content-length");
      if (expected && blob.size !== Number(expected)) throw new Error(t("文件传输不完整，请重试。"));
      const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
      const safePreview = /^(application\/pdf|image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|text\/plain)$/.test(mime);
      const url = URL.createObjectURL(new Blob([blob], { type: safePreview ? mime : "application/octet-stream" }));
      if (preview && safePreview) {
        preview.location.replace(url);
        const timer = window.setInterval(() => { if (preview.closed) { URL.revokeObjectURL(url); window.clearInterval(timer); } }, 3000);
      } else {
        preview?.close();
        const link = document.createElement("a"); link.href = url; link.download = (delivered ?? path).split(/[\\/]/).at(-1) || "download";
        document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (e) { preview?.close(); setError(e instanceof Error ? e.message : t("文件读取失败，请重试。")); }
    finally { setBusy(false); }
  }
  async function prepare() {
    if (busy || !window.confirm(t("将此文件复制到当前项目内用于下载？保留原文件，不覆盖已有文件；仅在主机空闲且权限允许时执行。") + `\n${path}`)) return;
    setBusy(true); setError("");
    try {
      const result = await api.prepareFileDelivery(sessionId, path, crypto.randomUUID());
      for (let i = 0; i < 35; i++) {
        await new Promise(resolve => window.setTimeout(resolve, 1500));
        const receipt = (await api.commandReceipts(sessionId)).find(c => c.id === result.command.id);
        if (receipt?.outcome === "succeeded") {
          if (receipt.codexResult?.status !== "completed") throw new Error(t("交付未完成，请在操作记录中查看主机返回；不会自动重试。"));
          setDelivered(result.path); setOutside(false); return;
        }
        if (receipt?.outcome === "failed" || receipt?.outcome === "unknown") throw new Error(receipt.message || t("交付结果待核验，请查看操作记录；不会自动重试。"));
      }
      throw new Error(t("交付结果待核验，请查看操作记录；不会自动重试。"));
    } catch (e) { setOutside(false); setError(e instanceof Error ? e.message : t("交付未完成，请查看操作记录。")); }
    finally { setBusy(false); }
  }
  return <span className="markdown-file">
    <span className="markdown-file__name">{children}</span>
    <span className="markdown-file__actions">
      <a href={fileUrl(sessionId, delivered ?? path)} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={e => { e.preventDefault(); void read(false); }} title={t("预览文件")}><Eye size={13} />{t("预览")}</a>
      <a href={fileUrl(sessionId, delivered ?? path, true)} target="_blank" rel="noopener noreferrer" aria-disabled={busy} onClick={e => { e.preventDefault(); void read(true); }} title={t("下载文件")}><Download size={13} />{t("下载")}</a>
    </span>
    {busy && <span role="status">{t("正在读取或准备文件…")}</span>}
    {error && <span className="markdown-file__error" role="alert">{error}{outside && <button type="button" disabled={busy} onClick={() => void prepare()}>{t("复制到项目交付")}</button>}</span>}
    {delivered && <span className="markdown-file__notice" role="status">{t("交付副本已准备好，请点击预览或下载。")}</span>}
  </span>;
}

/** Parse assistant prose only; raw view and execution logs retain their original bytes. */
export const MarkdownMessage = memo(function MarkdownMessage({ body, sessionId }: { body: string; sessionId?: string }) {
  const activeLocale = useLocale();
  const [copiedText, setCopiedText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const copied = copiedText === body;
  async function copyReply() {
    try { await copyText(body); setCopiedText(body); setFailed(false); }
    catch { setFailed(true); }
  }
  const components = useMemo<Components>(() => ({
    pre: CodeBlock,
    table: ({ children }) => <div className="markdown-table" role="region" aria-label={t("表格")} tabIndex={0}><table>{children}</table></div>,
    a: ({ node: _node, href, children, ...props }) => {
      const path = href ? hostFilePath(href) : undefined;
      if (path && sessionId) return <LocalFileLink sessionId={sessionId} path={path}>{children}</LocalFileLink>;
      return href ? <a {...props} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || t("查看图片")}</a> : <span>{alt}</span>,
  }), [activeLocale, sessionId]);
  return <div className="message-markdown">
    <div className="message-markdown__body"><Markdown remarkPlugins={[remarkGfm, remarkFileCitations, ...(sessionId ? [remarkHostFilePaths] : [])]} components={components} urlTransform={(url) => hostFilePath(url) ? url : defaultUrlTransform(url)} skipHtml>{body}</Markdown></div>
    <div className="message-markdown__actions">
      <button type="button" onClick={() => void copyReply()} aria-label={copied ? t("回复已复制") : t("复制回复")}>
        {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制回复")}
      </button>
      {failed && <span role="status">{t("复制失败，请手动选择回复内容。")}</span>}
    </div>
  </div>;
});
