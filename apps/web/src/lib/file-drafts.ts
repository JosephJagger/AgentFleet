import { t } from "../i18n";
import { useEffect, useState } from "react";

export const MAX_ATTACHMENT_FILES = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
export interface FileAttachment { id: string; name: string; relativePath: string; mimeType: string; size: number; data: string }

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
        prepared.push({ id: crypto.randomUUID(), name: file.name, relativePath, mimeType: file.type.slice(0, 200), size: file.size, data: await base64(file) });
      }
      setFiles(current => [...current, ...prepared]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("文件读取失败，请重新选择")); }
    finally { setProcessing(false); }
  }
  return { files, processing, error, add, remove: (id: string) => setFiles(current => current.filter(file => file.id !== id)), clear: () => setFiles([]) };
}
