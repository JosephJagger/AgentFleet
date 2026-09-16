import { invariant } from "./errors.js";

export const MAX_ATTACHMENT_FILES = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = new Set("txt md markdown mdx rst adoc csv tsv json jsonl ndjson yaml yml toml xml html htm css scss sass less svg js jsx mjs cjs ts tsx mts cts py pyi rb php java kt kts go rs c h cc cpp cxx hpp cs swift scala sh bash zsh fish ps1 bat cmd sql graphql gql proto tf tfvars hcl ini cfg conf env properties gradle cmake lock gitignore dockerignore editorconfig npmrc nvmrc".split(" "));
const NAMES = new Set("readme license copying dockerfile makefile procfile gemfile rakefile".split(" "));
function validateReadableText(name: string, bytes: Buffer): void {
  const lower=name.toLowerCase(); const extension=lower.includes(".") ? lower.split(".").at(-1)! : "";
  invariant(EXTENSIONS.has(extension)||NAMES.has(lower),400,"ATTACHMENT_TYPE_UNSUPPORTED",`不支持此文件类型：${name}。仅支持 UTF-8 文本、源码、配置和结构化数据文件`);
  try { invariant(!bytes.includes(0),400,"ATTACHMENT_TYPE_UNSUPPORTED",`文件不是可读取的 UTF-8 文本：${name}`); new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch { invariant(false,400,"ATTACHMENT_TYPE_UNSUPPORTED",`文件不是可读取的 UTF-8 文本：${name}`); }
}

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
    validateReadableText(item.name,bytes);
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

export function parsePlugins(value: unknown): Array<{ pluginId: string; pluginName: string }> {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 4, 400, "PLUGIN_INVALID", "一次最多添加 4 个插件");
  return value.map(raw => {
    invariant(raw && typeof raw === "object" && !Array.isArray(raw), 400, "PLUGIN_INVALID", "插件格式无效");
    const item = raw as Record<string, unknown>;
    invariant(Object.keys(item).every(key => ["pluginId", "pluginName"].includes(key)) && typeof item.pluginId === "string" && typeof item.pluginName === "string" && item.pluginId.length > 0 && item.pluginId.length <= 256 && item.pluginName.length > 0 && item.pluginName.length <= 256 && !item.pluginId.includes("\0") && !item.pluginName.includes("\0"), 400, "PLUGIN_INVALID", "插件格式无效");
    return { pluginId: item.pluginId, pluginName: item.pluginName };
  });
}
