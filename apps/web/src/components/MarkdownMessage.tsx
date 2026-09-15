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

function LocalFileLink({ sessionId, path, children }: { sessionId: string; path: string; children?: ReactNode }) {
  return <span className="markdown-file">
    <span className="markdown-file__name">{children}</span>
    <span className="markdown-file__actions">
      <a href={fileUrl(sessionId, path)} target="_blank" rel="noopener noreferrer" title={t("预览文件")}><Eye size={13} />{t("预览")}</a>
      <a href={fileUrl(sessionId, path, true)} target="_blank" rel="noopener noreferrer" title={t("下载文件")}><Download size={13} />{t("下载")}</a>
    </span>
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
    <div className="message-markdown__body"><Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => hostFilePath(url) ? url : defaultUrlTransform(url)} skipHtml>{body}</Markdown></div>
    <div className="message-markdown__actions">
      <button type="button" onClick={() => void copyReply()} aria-label={copied ? t("回复已复制") : t("复制回复")}>
        {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制回复")}
      </button>
      {failed && <span role="status">{t("复制失败，请手动选择回复内容。")}</span>}
    </div>
  </div>;
});
