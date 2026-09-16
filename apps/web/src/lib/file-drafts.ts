import { t } from "../i18n";
import { useEffect, useState } from "react";

export const MAX_ATTACHMENT_FILES = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
export interface FileAttachment { id: string; name: string; relativePath: string; mimeType: string; size: number; data: string }

export const ATTACHMENT_ACCEPT = ".pdf,.xlsx,.txt,.md,.markdown,.mdx,.rst,.adoc,.csv,.tsv,.json,.jsonl,.ndjson,.yaml,.yml,.toml,.xml,.html,.htm,.css,.scss,.sass,.less,.svg,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.pyi,.rb,.php,.java,.kt,.kts,.go,.rs,.c,.h,.cc,.cpp,.cxx,.hpp,.cs,.swift,.scala,.sh,.bash,.zsh,.fish,.ps1,.bat,.cmd,.sql,.graphql,.gql,.proto,.tf,.tfvars,.hcl,.ini,.cfg,.conf,.env,.properties,.gradle,.cmake,.lock,.gitignore,.dockerignore,.editorconfig,.npmrc,.nvmrc";
const EXTENSIONS = new Set(ATTACHMENT_ACCEPT.split(",").map(value => value.slice(1)));
const NAME_ALLOWLIST = new Set(["readme", "license", "copying", "dockerfile", "makefile", "procfile", "gemfile", "rakefile"]);
const XLSX_REQUIRED = new Set(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]);
const XLSX_FORBIDDEN = /(^|\/)(?:vbaProject\.bin|activeX\/|embeddings\/|externalLinks\/|oleObject)/i;

export function supportedAttachmentName(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").at(-1)! : "";
  return EXTENSIONS.has(extension) || NAME_ALLOWLIST.has(lower);
}

function formatMismatch(name: string): never { throw new Error(t("文件内容与受支持的格式不匹配：{0}", name)); }
function little(bytes: Uint8Array, offset: number, width: 2 | 4): number {
  if (offset < 0 || offset + width > bytes.length) return -1;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, width)[width === 2 ? "getUint16" : "getUint32"](0, true);
}
function validatePdf(bytes: Uint8Array, name: string): void {
  const header = new TextDecoder().decode(bytes.subarray(0, 5));
  const trailer = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 4_096)));
  if (bytes.length < 12 || header !== "%PDF-" || !trailer.includes("%%EOF")) formatMismatch(name);
}
function validateXlsx(bytes: Uint8Array, name: string): void {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) if (little(bytes, index, 4) === 0x06054b50) { eocd = index; break; }
  if (eocd < 0) formatMismatch(name);
  const entries = little(bytes, eocd + 10, 2), directorySize = little(bytes, eocd + 12, 4), directoryOffset = little(bytes, eocd + 16, 4);
  const zipCommentLength = little(bytes, eocd + 20, 2);
  if (little(bytes, eocd + 4, 2) !== 0 || little(bytes, eocd + 6, 2) !== 0 || little(bytes, eocd + 8, 2) !== entries || eocd + 22 + zipCommentLength !== bytes.length || !entries || entries > 2_000 || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize !== eocd) formatMismatch(name);
  const found = new Set<string>(); let offset = directoryOffset, expanded = 0;
  for (let count = 0; count < entries; count += 1) {
    if (offset + 46 > eocd || little(bytes, offset, 4) !== 0x02014b50) formatMismatch(name);
    const flags = little(bytes, offset + 8, 2), compressed = little(bytes, offset + 20, 4), uncompressed = little(bytes, offset + 24, 4);
    const nameLength = little(bytes, offset + 28, 2), extraLength = little(bytes, offset + 30, 2), commentLength = little(bytes, offset + 32, 2), localOffset = little(bytes, offset + 42, 4), end = offset + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff || end > eocd || localOffset + 30 > directoryOffset || little(bytes, localOffset, 4) !== 0x04034b50 || uncompressed > 32 * 1024 * 1024 || (compressed === 0 ? uncompressed > 0 : uncompressed / compressed > 200)) formatMismatch(name);
    const entry = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = little(bytes, localOffset + 26, 2), localExtraLength = little(bytes, localOffset + 28, 2), localData = localOffset + 30 + localNameLength + localExtraLength;
    if (localData + compressed > directoryOffset || new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== entry) formatMismatch(name);
    if (!entry || entry.includes("\0") || entry.includes("\\") || entry.startsWith("/") || entry.split("/").some(part => part === "..") || XLSX_FORBIDDEN.test(entry)) formatMismatch(name);
    found.add(entry); expanded += uncompressed; if (expanded > 64 * 1024 * 1024) formatMismatch(name); offset = end;
  }
  if (offset !== directoryOffset + directorySize || [...XLSX_REQUIRED].some(entry => !found.has(entry))) formatMismatch(name);
}
export function validateAttachmentBytes(bytes: Uint8Array, name: string): void {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  if (extension === "pdf") { validatePdf(bytes, name); return; }
  if (extension === "xlsx") { validateXlsx(bytes, name); return; }
  if (!supportedAttachmentName(name)) throw new Error(t("不支持此文件类型：{0}。支持 PDF、XLSX、UTF-8 文本、源码、配置和结构化数据文件。", name));
  if (bytes.includes(0)) throw new Error(t("文件不是可读取的 UTF-8 文本：{0}", name));
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(t("文件不是可读取的 UTF-8 文本：{0}", name)); }
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("文件读取失败，请重新选择")));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error(t("文件读取失败，请重新选择"))); else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function useFileDraft(session?: string) {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setFiles([]); setProcessing(false); setError(""); }, [session]);
  async function add(selected: File[]) {
    if (!selected.length) return;
    setError("");
    if (files.length + selected.length > MAX_ATTACHMENT_FILES) { setError(t("一次最多添加 32 个文件")); return; }
    if (selected.some(file => file.size <= 0 || file.size > MAX_ATTACHMENT_FILE_BYTES)) { setError(t("单个文件必须小于 4 MB，且不能为空")); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) + selected.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) { setError(t("文件总大小不能超过 8 MB")); return; }
    const paths = new Set(files.map(file => file.relativePath));
    const prepared: FileAttachment[] = [];
    setProcessing(true);
    try {
      for (const file of selected) {
        const relativePath = (file.webkitRelativePath || file.name).replaceAll("\\", "/");
        if (!relativePath || relativePath.split("/").some(part => !part || part === "." || part === "..") || paths.has(relativePath)) throw new Error(t("文件路径重复或无效：{0}", relativePath || file.name));
        paths.add(relativePath);
        validateAttachmentBytes(new Uint8Array(await file.arrayBuffer()), file.name);
        prepared.push({ id: crypto.randomUUID(), name: file.name, relativePath, mimeType: file.type.slice(0, 200), size: file.size, data: await base64(file) });
      }
      setFiles(current => [...current, ...prepared]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("文件读取失败，请重新选择")); }
    finally { setProcessing(false); }
  }
  return { files, processing, error, add, remove: (id: string) => setFiles(current => current.filter(file => file.id !== id)), clear: () => setFiles([]) };
}
