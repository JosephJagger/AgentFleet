import { constants } from "node:fs";
import { readdir, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AgentError } from "./errors.js";
import { verifyProjectIdentity } from "./projects.js";
import { isPathInside } from "./util.js";
import type { ProjectRecord } from "./types.js";
import type { CodexOperationRequest, CodexOperationResult } from "./codex-operations.js";

const MAX_BYTES = 48_000;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const denied = (name: string) => name.split(/[\\/]/).some(p => /^(?:\.git|\.codex|\.ssh|\.aws|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|\.agentfleet-trash)$/i.test(p));
const failure = (code: string, message: string): never => { throw new AgentError(code, message); };

/** Paths are always relative to the registered project; never accept arbitrary host roots. */
async function target(root: string, value: unknown, missing = false): Promise<string> {
  if (typeof value !== "string" || !value.trim() || denied(value)) return failure("FILE_ACCESS_DENIED", "请选择项目内的普通文件");
  const path = resolve(root, value);
  if (path === root || !isPathInside(root, path) || denied(relative(root, path))) return failure("FILE_OUTSIDE_PROJECT", "文件必须位于当前项目内");
  const parent = await realpath(dirname(path));
  if (parent !== dirname(path) || !isPathInside(root, parent)) return failure("FILE_OUTSIDE_PROJECT", "不允许通过链接访问项目外文件");
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.nlink > 1 || await realpath(path) !== path) return failure("FILE_ACCESS_DENIED", "链接文件不支持网页编辑");
  } catch (e) { if (!(missing && (e as NodeJS.ErrnoException).code === "ENOENT")) throw e; }
  return path;
}
async function read(path: string) {
  const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await h.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > MAX_BYTES) return failure("FILE_NOT_EDITABLE", "网页编辑仅支持 48 KB 以内的普通文本文件；其他文件请下载");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES || bytesRead !== info.size) return failure("FILE_CHANGED", "文件已变化，请重新读取");
    const data = buffer.subarray(0, bytesRead);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return failure("FILE_NOT_EDITABLE", "此文件不是 UTF-8 文本，请下载查看"); }
    if (text.includes("\0")) return failure("FILE_NOT_EDITABLE", "二进制文件请下载查看");
    const after = await h.stat();
    if (info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) return failure("FILE_CHANGED", "文件已变化，请重新读取");
    return { data, text, revision: digest(data), mode: info.mode, info };
  } finally { await h.close(); }
}
async function writeExclusive(path: string, data: Buffer | string, mode: number) {
  const h = await open(path, "wx", mode);
  const identity = await h.stat();
  try { await h.writeFile(data); await h.sync(); }
  catch (error) {
    await h.close();
    const current = await lstat(path).catch(() => null);
    if (current && current.dev === identity.dev && current.ino === identity.ino) await rm(path, { force: true });
    throw error;
  }
  finally { await h.close(); }
}
async function trashRoot(root: string) {
  const dir = join(root, ".agentfleet-trash");
  await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
  if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) return failure("FILE_ACCESS_DENIED", "项目回收站路径无效");
  return dir;
}

export async function projectWorkspaceFiles(request: CodexOperationRequest, project: ProjectRecord): Promise<CodexOperationResult> {
  await verifyProjectIdentity(project);
  const { operation, arguments: args } = request;
  const result = (rows: CodexOperationResult["rows"], status = "completed") => ({ operation, status, rows });
  if (operation === "files.trash") {
    const dir = join(project.root, ".agentfleet-trash");
    const info = await lstat(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (!info) return result([], "available");
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) return failure("FILE_ACCESS_DENIED", "项目回收站路径无效");
    const names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile() && /^\d+-[a-f0-9-]{36}-/.test(e.name)).map(e => e.name).sort().reverse();
    return result(names.slice(0, 50).map(name => ({ name, detail: name.slice(name.indexOf("-") + 38), status: "可恢复到新文件；最近 50 份" })), "available");
  }
  if (operation === "files.restore") {
    const dir = await trashRoot(project.root);
    const name = String(args.backup);
    if (basename(name) !== name || !/^\d+-[a-f0-9-]{36}-/.test(name)) return failure("FILE_ACCESS_DENIED", "备份标识无效");
    const backup = join(dir, name);
    if ((await lstat(backup)).isSymbolicLink()) return failure("FILE_ACCESS_DENIED", "备份路径无效");
    const saved = await read(backup);
    const dest = await target(project.root, args.destination, true);
    await writeExclusive(dest, saved.data, saved.mode & 0o777);
    return result([{ name: "恢复文件", detail: relative(project.root, dest), status: "已恢复；原备份保留" }]);
  }
  const path = await target(project.root, args.path, operation === "files.create" || operation === "files.mkdir");
  if (operation === "files.mkdir") { await mkdir(path); return result([{ name: "目录", detail: relative(project.root, path), status: "已创建" }]); }
  if (operation === "files.create") {
    await writeExclusive(path, String(args.text ?? ""), 0o600);
    return result([{ name: "文件", detail: relative(project.root, path), status: "已创建" }]);
  }
  const before = await read(path);
  if (operation === "files.read") return result([
    { name: "revision", detail: before.revision, status: "保存时核对版本" },
    ...Array.from({ length: Math.max(1, Math.ceil(before.text.length / 1100)) }, (_, i) => ({ name: `content:${i}`, detail: before.text.slice(i * 1100, (i + 1) * 1100), status: "UTF-8" })),
  ], "available");
  if (args.revision !== before.revision) return failure("FILE_CHANGED", "文件已被其他程序修改，请重新读取并合并修改");
  if (operation === "files.copy") {
    const dest = await target(project.root, args.destination, true);
    await writeExclusive(dest, before.data, before.mode & 0o777);
    return result([{ name: "副本", detail: relative(project.root, dest), status: "已复制" }]);
  }
  const trash = await trashRoot(project.root);
  const backup = join(trash, `${Date.now()}-${randomUUID()}-${basename(path).slice(0, 120)}`);
  if (operation === "files.remove") {
    // Rename instead of deletion: preserves the user's original file for recovery.
    await target(project.root, args.path);
    if ((await read(path)).revision !== before.revision) return failure("FILE_CHANGED", "文件已变化，请重新读取");
    await rename(path, backup);
    return result([{ name: "恢复位置", detail: relative(project.root, backup), status: "已移入项目回收站，未永久删除" }]);
  }
  if (operation !== "files.write") return failure("CODEX_OPERATION_INVALID", "不支持的文件操作");
  const temporary = join(dirname(path), `.agentfleet-edit-${randomUUID()}`);
  try {
    const h = await open(temporary, "wx", before.mode & 0o777);
    try { await h.writeFile(String(args.text), "utf8"); await h.sync(); } finally { await h.close(); }
    // Keep a recovery copy and recheck immediately before replacing the file.
    await writeExclusive(backup, before.data, before.mode & 0o777);
    await target(project.root, args.path);
    if ((await read(path)).revision !== before.revision) return failure("FILE_CHANGED", "保存前文件发生变化，请重新读取");
    await rename(temporary, path);
    return result([{ name: "revision", detail: digest(Buffer.from(String(args.text), "utf8")), status: "已保存" }, { name: "备份", detail: relative(project.root, backup), status: "保留修改前内容" }]);
  } finally { await rm(temporary, { force: true }); }
}
