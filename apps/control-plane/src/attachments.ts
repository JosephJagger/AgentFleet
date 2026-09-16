import { invariant } from "./errors.js";

export const MAX_ATTACHMENT_FILES = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

export function parseAttachments(value: unknown): Array<{ name: string; relativePath: string; mimeType: string; data: string }> {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= MAX_ATTACHMENT_FILES, 400, "ATTACHMENT_INVALID", `一次最多添加 ${MAX_ATTACHMENT_FILES} 个文件`);
  let total = 0;
  const paths = new Set<string>();
  return value.map(raw => {
    invariant(raw && typeof raw === "object" && !Array.isArray(raw), 400, "ATTACHMENT_INVALID", "文件附件格式无效");
    const item = raw as Record<string, unknown>;
    invariant(Object.keys(item).every(key => ["name", "relativePath", "mimeType", "data"].includes(key)), 400, "ATTACHMENT_INVALID", "文件附件包含未知字段");
    invariant(typeof item.relativePath === "string" && item.relativePath.length > 0 && item.relativePath.length <= 1_024 && !item.relativePath.includes("\0") && !item.relativePath.includes("\\") && item.relativePath.split("/").every(part => part && part !== "." && part !== ".."), 400, "ATTACHMENT_INVALID", "文件路径无效");
    invariant(!paths.has(item.relativePath), 400, "ATTACHMENT_INVALID", "文件附件路径重复"); paths.add(item.relativePath);
    invariant(typeof item.name === "string" && item.name.length > 0 && item.name.length <= 255 && item.name === item.relativePath.split("/").at(-1), 400, "ATTACHMENT_INVALID", "文件名无效");
    invariant(typeof item.mimeType === "string" && item.mimeType.length <= 200 && !item.mimeType.includes("\0"), 400, "ATTACHMENT_INVALID", "文件类型无效");
    invariant(typeof item.data === "string" && item.data.length <= Math.ceil(MAX_ATTACHMENT_FILE_BYTES / 3) * 4 + 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data), 400, "ATTACHMENT_INVALID", "文件内容无效");
    const bytes = Buffer.from(item.data, "base64");
    invariant(bytes.length > 0 && bytes.length <= MAX_ATTACHMENT_FILE_BYTES && bytes.toString("base64") === item.data, 400, "ATTACHMENT_INVALID", `单个文件不能超过 ${MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024} MB`);
    total += bytes.length; invariant(total <= MAX_ATTACHMENT_TOTAL_BYTES, 400, "ATTACHMENT_INVALID", `文件总大小不能超过 ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB`);
    return { name: item.name, relativePath: item.relativePath, mimeType: item.mimeType, data: item.data };
  });
}

export function parsePluginSkills(value: unknown): Array<{ pluginId: string; name: string; path: string }> {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 8, 400, "PLUGIN_SKILL_INVALID", "一次最多添加 8 个插件技能");
  return value.map(raw => {
    invariant(raw && typeof raw === "object" && !Array.isArray(raw), 400, "PLUGIN_SKILL_INVALID", "插件技能格式无效");
    const item = raw as Record<string, unknown>;
    invariant(Object.keys(item).every(key => ["pluginId", "name", "path"].includes(key)) && typeof item.pluginId === "string" && typeof item.name === "string" && typeof item.path === "string" && item.pluginId.length > 0 && item.pluginId.length <= 256 && item.name.length > 0 && item.name.length <= 256 && item.path.length > 0 && item.path.length <= 8_192 && !item.path.includes("\0"), 400, "PLUGIN_SKILL_INVALID", "插件技能格式无效");
    return { pluginId: item.pluginId, name: item.name, path: item.path };
  });
}
