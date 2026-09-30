import { realpath, lstat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { AgentError } from "./errors.js";
import { isPathInside } from "./util.js";
import { verifyProjectIdentity, verifySessionCwd } from "./projects.js";
import { turnPermissionPolicy } from "./permissions.js";
import { sanitizeCodexResult, type CodexOperationRequest, type CodexOperationResult } from "./codex-operations.js";
import type { ManagedThread, ProjectRecord } from "./types.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const hidden = (path: string) => path.split(/[\\/]/).some(part => /^(?:\.git|\.codex|\.ssh|\.aws|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part));

/** Native workspace APIs inherit the registered project boundary, never arbitrary roots, cwd or env. */
export async function executeCodexWorkspaceOperation(request: CodexOperationRequest, thread: ManagedThread, project: ProjectRecord, rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<CodexOperationResult> {
  await verifyProjectIdentity(project);
  const cwd = await verifySessionCwd(project, thread.sessionCwd ?? project.root);
  const { operation, arguments: args } = request;
  if (operation === "terminal.run") {
    const result = object(await rpc("command/exec", { command: args.argv, cwd, sandboxPolicy: turnPermissionPolicy(project.root, thread.permissionProfile ?? "project"), timeoutMs: 30_000, outputBytesCap: 12_000 }));
    return sanitizeCodexResult({ operation, status: result.exitCode === 0 ? "completed" : "partialFailure", rows: [{ name: "退出码", detail: String(result.exitCode), status: "独立原生命令；不创建 Codex 轮次" }, ...["stdout", "stderr"].flatMap(key => typeof result[key] === "string" && result[key] ? (result[key] as string).match(/[\s\S]{1,1100}/g)!.slice(0, 12).map((detail, index) => ({ name: `${key} ${index + 1}`, detail, status: "最多运行 30 秒；输出有大小限制" })) : [])] })!;
  }
  if (operation === "files.list") {
    const path = resolve(cwd, typeof args.path === "string" ? args.path : ".");
    const canonical = await realpath(path).catch(() => { throw new AgentError("CODEX_TARGET_CHANGED", "Project directory is unavailable"); });
    if (!isPathInside(project.root, canonical) || canonical !== path || hidden(relative(project.root, canonical)) || !(await lstat(canonical)).isDirectory()) throw new AgentError("CODEX_TARGET_CHANGED", "Directory is outside the permitted project boundary");
    const raw = object(await rpc("fs/readDirectory", { path: canonical }));
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(object).filter(entry => typeof entry.fileName === "string" && entry.fileName !== "." && entry.fileName !== ".." && !/[\\/]/.test(entry.fileName) && !hidden(entry.fileName)).sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
    const offset = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new AgentError("CODEX_OPERATION_INVALID", "Invalid directory page");
    return sanitizeCodexResult({ operation, status: "available", rows: entries.slice(offset, offset + 25).map(entry => ({ name: entry.fileName, detail: relative(cwd, resolve(canonical, String(entry.fileName))), status: entry.isDirectory ? "目录" : entry.isFile ? "文件" : "其他类型" })), ...(offset + 25 < entries.length ? { nextCursor: String(offset + 25) } : {}) })!;
  }
  const raw = object(await rpc("fuzzyFileSearch", { query: args.query, roots: [project.root] }));
  const rows: CodexOperationResult["rows"] = [];
  for (const value of Array.isArray(raw.files) ? raw.files.slice(0, 100) : []) {
    const file = object(value);
    if (file.root !== project.root || typeof file.path !== "string" || hidden(file.path)) continue;
    const path = resolve(project.root, file.path);
    const canonical = await realpath(path).catch(() => null);
    if (!canonical || !isPathInside(project.root, canonical) || canonical !== path) continue;
    rows.push({ name: String(file.file_name ?? ""), detail: relative(project.root, canonical), status: file.match_type === "directory" ? "目录" : "文件" });
  }
  if (rows.length > 49) { rows.splice(49); rows.push({ name: "结果过多", detail: "请缩小搜索范围", status: "仅显示前 49 项" }); }
  return sanitizeCodexResult({ operation, status: "available", rows })!;
}
