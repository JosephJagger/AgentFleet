import { withVersionLock } from "./version-cleanup.js";
import { retryUpdateDownload } from "./update-network.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { expectedCodexSchemaHash } from "./constants.js";
import { loadRuntimeProfile } from "./runtime-profile.js";
import { AgentError } from "./errors.js";
import { MANAGED_BWRAP_SHA256, stageSandboxHelper, validSandboxHelper, type SandboxHelperArtifact } from "./managed-sandbox-helper.js";
import { codeModeName, stageCodeModeHost, validCodeModeArtifact, type CodeModeArtifact } from "./managed-code-mode.js";
const exec = promisify(execFile);
export interface ManagedRuntimeTarget {
  schemaVersion: 1; revision: string; version: string; schemaHash: string; rollback?: boolean;
  artifacts: Record<string, { file: string; sha256: string; size: number; format: "raw" }>;
  sandboxHelper?: SandboxHelperArtifact;
  codeModeHosts?: Record<string, CodeModeArtifact>;
}
export function parseManagedRuntimeTarget(value: unknown): ManagedRuntimeTarget | null {
  if (value === null || value === undefined) return null;
  const target = value as ManagedRuntimeTarget;
  if (target.schemaVersion !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.revision) || !/^\d+\.\d+\.\d+$/.test(target.version) || (target.rollback !== undefined && typeof target.rollback !== "boolean") || (!/^[a-f0-9]{64}$/.test(target.schemaHash) || target.schemaHash !== expectedCodexSchemaHash(target.version)) || !target.artifacts || typeof target.artifacts !== "object") throw new AgentError("RUNTIME_TARGET_INVALID", "托管目标版本或协议未通过本 Agent 的兼容检查");
  for (const [platform, asset] of Object.entries(target.artifacts)) {
    if (!["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"].includes(platform) || asset.format !== "raw" || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024 || asset.file !== `codex-${platform}-${target.version}-${asset.sha256.slice(0, 16)}${platform === "win32-x64" ? ".exe" : ""}`) throw new AgentError("RUNTIME_TARGET_INVALID", "托管目标安装包信息不完整或路径无效");
  }
  if (target.sandboxHelper !== undefined && !validSandboxHelper(target.sandboxHelper, target.version)) throw new AgentError("RUNTIME_TARGET_INVALID", "托管隔离辅助程序信息无效");
  if (target.codeModeHosts !== undefined && (!target.codeModeHosts || typeof target.codeModeHosts !== "object" || Array.isArray(target.codeModeHosts) || Object.entries(target.codeModeHosts).some(([platform, artifact]) => !validCodeModeArtifact(artifact, target.version, platform)))) throw new AgentError("RUNTIME_TARGET_INVALID", "Code Mode 执行程序发布信息无效");
  return target;
}
/** Download and verify only. The caller owns the idle/drain gate and rollback transaction. */
export async function prepareManagedRuntime(options: { dataDir: string; controlPlaneUrl: string; target: ManagedRuntimeTarget; signal?: AbortSignal }): Promise<() => Promise<void>> {
  return withVersionLock(options.dataDir, () => prepareRuntimeLocked(options));
}

interface PreparedRuntime {
  key: string; directory: string; profile: string; helperHash?: string;
  files: Array<{name: string; sha256: string; size: number}>;
}
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function validPrepared(root: string, prepared: PreparedRuntime): Promise<boolean> {
  try {
    if (!/^\d+\.\d+\.\d+-[\w-]+$/.test(prepared.directory) || !Array.isArray(prepared.files)) return false;
    const directory = join(root, prepared.directory);
    if (await realpath(directory) !== resolve(directory)) return false;
    for (const file of prepared.files) {
      if (!["codex", "codex.exe", "codex-code-mode-host", "codex-code-mode-host.exe", "codex-resources/bwrap"].includes(file.name)) return false;
      const path = join(directory, file.name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== resolve(path) || stat.size !== file.size || await fileDigest(path) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}
async function prepareRuntimeLocked(options: Parameters<typeof prepareManagedRuntime>[0]): Promise<() => Promise<void>> {
  const target = parseManagedRuntimeTarget(options.target)!;
  const profile = await loadRuntimeProfile(options.dataDir);
  if (!profile || profile.source !== "managed") throw new AgentError("RUNTIME_NOT_MANAGED", "自装 Codex 不参与托管运行时自动切换");
  const platform = `${process.platform}-${process.arch}`;
  const artifact = target.artifacts[platform];
  if (!artifact) throw new AgentError("RUNTIME_PLATFORM_UNAVAILABLE", "托管目标尚未提供本机平台安装包");
  const root = join(options.dataDir, "codex", "releases");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== resolve(root)) throw new AgentError("RUNTIME_PATH_UNSAFE", "托管版本目录包含链接");
  const preparedPath = join(options.dataDir, "runtime-prepared.json");
  const key = JSON.stringify(target), profileKey = JSON.stringify(profile);
  const expected = new Map<string, {sha256: string; size?: number}>([
    [process.platform === "win32" ? "codex.exe" : "codex", artifact],
  ]);
  const codeMode = target.codeModeHosts?.[platform];
  if (codeMode) expected.set(codeModeName(), codeMode);
  if (process.platform === "linux") expected.set("codex-resources/bwrap", { sha256: target.sandboxHelper?.sha256 ?? (target.version === "0.153.2" ? "01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8" : target.version === "0.153.4" ? MANAGED_BWRAP_SHA256 : ""), ...(target.sandboxHelper ? {size: target.sandboxHelper.size} : {}) });
  const trusted = (prepared: PreparedRuntime) => Array.isArray(prepared.files) && prepared.files.length === expected.size &&
    [...expected].every(([name, value]) => prepared.files.some(file => file.name === name && file.sha256 === value.sha256 && (value.size === undefined || file.size === value.size))) &&
    (process.platform !== "linux" || prepared.helperHash === expected.get("codex-resources/bwrap")?.sha256);
  const activate = (prepared: PreparedRuntime) => async () => withVersionLock(options.dataDir, async () => {
    if (JSON.stringify(await loadRuntimeProfile(options.dataDir)) !== prepared.profile) throw new AgentError("RUNTIME_PROFILE_CHANGED", "运行配置已变化，请重新检查更新");
    if (!trusted(prepared) || !await validPrepared(root, prepared)) throw new AgentError("RUNTIME_CHECKSUM_FAILED", "准备好的运行时已变化，保留原版本");
    const path = join(options.dataDir, "runtime-profile.json"), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...profile, codexExecutable: join(root, prepared.directory, process.platform === "win32" ? "codex.exe" : "codex"), managedReleaseRevision: target.revision, managedVersion: target.version, ...(prepared.helperHash ? { managedSandboxHelperSha256: prepared.helperHash } : {}) }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  });
  try {
    const stat = await lstat(preparedPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024) {
      const cached: PreparedRuntime = JSON.parse(await readFile(preparedPath, "utf8"));
      const names = [process.platform === "win32" ? "codex.exe" : "codex", codeModeName(), ...(process.platform === "linux" ? ["codex-resources/bwrap"] : [])];
      if (cached.key === key && cached.profile === profileKey && trusted(cached) && cached.files?.length === names.length && names.every(name => cached.files.some(file => file.name === name)) && await validPrepared(root, cached)) return activate(cached);
    }
  } catch { /* A missing or invalid prepared record must be rebuilt and verified. */ }
  const stage = await mkdtemp(join(root, `${target.version}-`));
  const executable = join(stage, process.platform === "win32" ? "codex.exe" : "codex");
  let committed = false;
  try {
    const helperHash = await stageSandboxHelper(options.dataDir, stage, process.platform, process.arch, target.version, options.controlPlaneUrl, target.sandboxHelper);
    await stageCodeModeHost(stage, target.version, options.controlPlaneUrl, target.codeModeHosts?.[platform], false, options.signal);
    await retryUpdateDownload(async () => {
      await rm(executable, { force: true });
    const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(options.signal ? [options.signal] : [])]);
    const response = await fetch(new URL(`/downloads/managed-codex/${artifact.file}`, options.controlPlaneUrl), { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new AgentError("RUNTIME_DOWNLOAD_FAILED", `托管运行时下载失败 HTTP ${response.status}`);
    let bytes = 0; const hash = createHash("sha256");
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > artifact.size) callback(new Error("托管程序大小超限")); else { hash.update(chunk); callback(null, chunk); } } });
    const chunks = async function* () { const reader = response.body!.getReader(); try { while (true) { const next = await reader.read(); if (next.done) break; yield next.value; } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); } };
    await pipeline(chunks(), bounded, createWriteStream(executable, { flags: "wx", mode: 0o700 }));
    if (bytes !== artifact.size || hash.digest("hex") !== artifact.sha256) throw new AgentError("RUNTIME_CHECKSUM_FAILED", "托管程序 SHA-256 不一致，已保留原运行时");
    }, options.signal);
    await chmod(executable, 0o700);
    const env = { ...process.env, CODEX_HOME: join(stage, "validation-home") };
    await mkdir(env.CODEX_HOME, { mode: 0o700 });
    const execOptions = { env, timeout: 20_000, maxBuffer: 64 * 1024, ...(options.signal ? { signal: options.signal } : {}) };
    if ((await exec(executable, ["--version"], execOptions)).stdout.trim() !== `codex-cli ${target.version}`) throw new AgentError("RUNTIME_VERSION_FAILED", "托管程序版本验证失败");
    const schema = join(stage, "schema");
    await exec(executable, ["app-server", "generate-json-schema", "--out", schema], execOptions);
    if (createHash("sha256").update(await readFile(join(schema, "codex_app_server_protocol.v2.schemas.json"))).digest("hex") !== target.schemaHash) throw new AgentError("RUNTIME_SCHEMA_FAILED", "本机平台协议验证不通过，已保留原运行时");
    // This unique directory is not referenced by the profile until validation
    // succeeds. Keep it in place: Windows can retain handles to generated helper
    // files and reject renaming the entire directory even after Codex exits.
    // Activation still atomically changes only the profile, preserving rollback.
    const names = [process.platform === "win32" ? "codex.exe" : "codex", codeModeName(), ...(process.platform === "linux" ? ["codex-resources/bwrap"] : [])];
    const files = await Promise.all(names.map(async name => ({ name, size: (await lstat(join(stage, name))).size, sha256: await fileDigest(join(stage, name)) })));
    const prepared: PreparedRuntime = { key, directory: basename(stage), profile: profileKey, files, ...(helperHash ? { helperHash } : {}) };
    const temporary = `${preparedPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(prepared), { flag: "wx", mode: 0o600 });
    await rename(temporary, preparedPath);
    committed = true;
    return activate(prepared);
  } finally { if (!committed) await rm(stage, { recursive: true, force: true }); }
}
