import { AgentError } from "./errors.js";

export const MAX_ATTACHMENT_FILES = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = new Set("txt md markdown mdx rst adoc csv tsv json jsonl ndjson yaml yml toml xml html htm css scss sass less svg js jsx mjs cjs ts tsx mts cts py pyi rb php java kt kts go rs c h cc cpp cxx hpp cs swift scala sh bash zsh fish ps1 bat cmd sql graphql gql proto tf tfvars hcl ini cfg conf env properties gradle cmake lock gitignore dockerignore editorconfig npmrc nvmrc".split(" "));
const NAMES = new Set("readme license copying dockerfile makefile procfile gemfile rakefile".split(" "));
function validateReadableText(name:string,bytes:Buffer):void { const lower=name.toLowerCase();const extension=lower.includes(".")?lower.split(".").at(-1)!:"";if(!EXTENSIONS.has(extension)&&!NAMES.has(lower))throw new AgentError("ATTACHMENT_TYPE_UNSUPPORTED",`不支持此文件类型：${name}。仅支持 UTF-8 文本、源码、配置和结构化数据文件`);try{if(bytes.includes(0))throw new Error();new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new AgentError("ATTACHMENT_TYPE_UNSUPPORTED",`文件不是可读取的 UTF-8 文本：${name}`);}}

export interface UploadedAttachment {
  name: string;
  relativePath: string;
  mimeType: string;
  data: string;
}

export interface PluginSkillReference { pluginId: string; name: string; path: string }
export interface MaterializedAttachment { name: string; path: string }
export interface TurnExtras { attachments?: MaterializedAttachment[]; pluginSkills?: PluginSkillReference[]; goal?: string }

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1_024 || value.includes("\0") || value.includes("\\"))
    throw new AgentError("ATTACHMENT_INVALID", "文件路径无效");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new AgentError("ATTACHMENT_INVALID", "文件路径无效");
  return parts.join("/");
}

export function parseAttachments(value: unknown): UploadedAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_FILES) throw new AgentError("ATTACHMENT_INVALID", `一次最多添加 ${MAX_ATTACHMENT_FILES} 个文件`);
  let total = 0;
  const paths = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError("ATTACHMENT_INVALID", "文件附件格式无效");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["name", "relativePath", "mimeType", "data"].includes(key))) throw new AgentError("ATTACHMENT_INVALID", "文件附件包含未知字段");
    const relativePath = safeRelativePath(item.relativePath);
    if (paths.has(relativePath)) throw new AgentError("ATTACHMENT_INVALID", "文件附件路径重复");
    paths.add(relativePath);
    if (typeof item.name !== "string" || !item.name || item.name.length > 255 || item.name !== relativePath.split("/").at(-1)) throw new AgentError("ATTACHMENT_INVALID", "文件名无效");
    if (typeof item.mimeType !== "string" || item.mimeType.length > 200 || item.mimeType.includes("\0")) throw new AgentError("ATTACHMENT_INVALID", "文件类型无效");
    if (typeof item.data !== "string" || item.data.length > Math.ceil(MAX_ATTACHMENT_FILE_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw new AgentError("ATTACHMENT_INVALID", "文件内容无效");
    const bytes = Buffer.from(item.data, "base64");
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_FILE_BYTES || bytes.toString("base64") !== item.data) throw new AgentError("ATTACHMENT_INVALID", `单个文件不能超过 ${MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024} MB`);
    total += bytes.length;
    validateReadableText(item.name,bytes);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AgentError("ATTACHMENT_INVALID", `文件总大小不能超过 ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB`);
    return { name: item.name, relativePath, mimeType: item.mimeType, data: item.data };
  });
}

export function parsePluginSkills(value: unknown): PluginSkillReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new AgentError("PLUGIN_SKILL_INVALID", "一次最多添加 8 个插件技能");
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError("PLUGIN_SKILL_INVALID", "插件技能格式无效");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["pluginId", "name", "path"].includes(key)) || typeof item.pluginId !== "string" || typeof item.name !== "string" || typeof item.path !== "string" || !item.pluginId || !item.name || !item.path || item.pluginId.length > 256 || item.name.length > 256 || item.path.length > 8_192 || item.path.includes("\0")) throw new AgentError("PLUGIN_SKILL_INVALID", "插件技能格式无效");
    return { pluginId: item.pluginId, name: item.name, path: item.path };
  });
}
