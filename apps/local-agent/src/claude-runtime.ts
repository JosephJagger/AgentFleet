import { parseImages } from "./images.js";
import { sshAccess } from "./ssh-access.js";
import { type ClaudeSettings } from "./claude-settings.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { access, readlink, readdir, readFile } from "node:fs/promises";
import { delimiter, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { query, listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, type Query, type SDKUserMessage, type PermissionResult, type Options } from "@anthropic-ai/claude-agent-sdk";
import { validateSubagentRequest, type NativeSubagent, type NativeSubagentMessage, type NativeSubagentsPage } from "./native-subagents.js";
import type { AppServerClient, AppServerCallbacks, ThreadHistorySnapshot, ThreadHistoryPage } from "./app-server.js";
import type { ManagedThread, ProjectRecord, ApprovalRecord } from "./types.js";
import type { CodexSettings } from "./codex-settings.js";
import type { PermissionProfile } from "./permissions.js";
import type { TurnExtras } from "./attachments.js";
import type { InputAnswers } from "./user-input.js";
import { AgentError } from "./errors.js";
import { isRecord, nowIso, sha256, canonicalJson } from "./util.js";

import { inspectClaudeMetadata, retainedClaudeQuota, type ClaudeModel, type ClaudeQuota } from "./claude-metadata.js";

export const CLAUDE_PREFIX = "claude_";
export const isClaudeThread = (id: string) => id.startsWith(CLAUDE_PREFIX);
export const isClaudeProject = (project: ProjectRecord) => project.provider === "claude";
const nativeId = (id: string) => id.slice(CLAUDE_PREFIX.length);
const execFileAsync = promisify(execFile);
function supportsClaudeSteering(version: string | null): boolean {
  const v = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return Boolean(v && (Number(v[1]) > 2 || Number(v[1]) === 2 && (Number(v[2]) > 1 || Number(v[2]) === 1 && Number(v[3]) >= 265)));
}

export interface ClaudeAvailability { steerSupported?: boolean; managed?: boolean; installed: boolean; version: string | null; error?: string; models?: ClaudeModel[]; quota?: ClaudeQuota; permissionModes?: string[]; }

/** Probe the selected binary, including managed installations outside PATH. No prompt or settings writes. */
export async function detectClaudePermissionModes(executable: string): Promise<string[]> {
  try {
    const nodeScript = /\.[cm]?js$/i.test(executable);
    const help = await execFileAsync(nodeScript ? process.execPath : executable, nodeScript ? [executable, "--help"] : ["--help"], { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true });
    const choices = /--permission-mode\s+<mode>[\s\S]*?choices:\s*([^)]*)/u.exec(help.stdout)?.[1] ?? "";
    return ["default", "auto", "acceptEdits", "dontAsk"].filter(mode => choices.includes(`"${mode === "default" ? "manual" : mode}"`) || choices.includes(`"${mode}"`));
  } catch { return []; } // Missing/unreadable capability metadata never grants permission.
}

export async function detectClaude(): Promise<ClaudeAvailability & { path?: string }> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...new Set([...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute), join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin"), ...(process.platform === "win32" ? [join(homedir(), "AppData", "Roaming", "npm")] : ["/usr/local/bin", "/opt/homebrew/bin"])])];
  for (const dir of dirs) for (const name of names) {
    const path = join(dir, name);
    try {
      await access(path);
      const executable = name.endsWith(".cmd") ? join(dir,"node_modules","@anthropic-ai","claude-code","cli.js") : path;
      const result = await execFileAsync(name.endsWith(".cmd") ? process.execPath : executable, name.endsWith(".cmd") ? [executable,"--version"] : ["--version"], { timeout: 5000, windowsHide: true });
      const permissionModes = await detectClaudePermissionModes(executable);
      return { installed: true, version: result.stdout.trim().slice(0, 100), path: executable,permissionModes };
    } catch { /* Probe candidates without changing host auth or settings. */ }
  }
  return { installed: false, version: null };
}

// Refuse a second writer while a native terminal still owns its process.
// No process-name killing or credential copying is used for handoff.
export async function nativeClaudeRunning(cwd: string, owned: Set<number>): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'claude-code') } | Select-Object -ExpandProperty ProcessId"], {timeout:5000,windowsHide:true});
    // Windows does not expose another process's cwd. Conservatively refuse a
    // native writer anywhere on this host instead of risking transcript damage.
    return result.stdout.split(/\s+/).some(pid => /^\d+$/.test(pid) && !owned.has(Number(pid)));
  }
  if (process.platform === "darwin") {
    const result = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], {timeout:5000});
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+/.exec(line);
      if (!match || owned.has(Number(match[1])) || !/(?:\/claude(?:\s|$)|claude-code\/.*cli\.js)/.test(line)) continue;
      try { const location = await execFileAsync("lsof", ["-a", "-p",match[1]!,"-d","cwd","-Fn"], {timeout:5000}); if (location.stdout.split("\n").includes(`n${cwd}`)) return true; } catch { /* Process exited. */ }
    }
    return false;
  }
  if (process.platform !== "linux") throw new AgentError("CLAUDE_HOST_CHECK_UNAVAILABLE", "当前系统无法核验 Claude 终端状态");
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || owned.has(Number(pid))) continue;
    try {
      const executable = await readlink(`/proc/${pid}/exe`);
      let native = /\/claude(?: \(deleted\))?$/.test(executable) || executable.includes("/claude/versions/");
      if (!native && /\/node(?: \(deleted\))?$/.test(executable)) native = /claude-code\/.*cli\.js/.test(await readFile(`/proc/${pid}/cmdline`, "utf8"));
      if (native && await readlink(`/proc/${pid}/cwd`) === cwd) return true;
    } catch { /* Process exited or is inaccessible. */ }
  }
  return false;
}

function messageItems(value: unknown): Array<{ nativeTurnId: string; nativeItemId: string; item: Record<string, unknown> }> {
  if (!isRecord(value) || !isRecord(value.message)) return [];
  const id = value.type === "assistant" && typeof value.message.id === "string" ? value.message.id : typeof value.uuid === "string" ? value.uuid : sha256(canonicalJson(value));
  const content = value.message.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isRecord) : [];
  const result: ReturnType<typeof messageItems> = [];
  const text = blocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).join("");
  const userContent: Record<string, unknown>[] = text ? [{type:"text",text}] : [];
  if (value.type === "user") {
    for (const block of blocks) {
      const source = block.source;
      if (block.type === "image" && isRecord(source) && source.type === "base64" &&
          typeof source.media_type === "string" && /^image\/(png|jpeg|gif|webp)$/.test(source.media_type) && typeof source.data === "string") {
        userContent.push({type:"image",url:`data:${source.media_type};base64,${source.data}`});
      }
    }
    if (userContent.length) result.push({nativeTurnId:id,nativeItemId:`${id}:text`,item:{id:`${id}:text`,type:"userMessage",content:userContent}});
  }
  let textAdded = value.type === "user";
  for (const block of blocks) {
    if (block.type === "text" && text && !textAdded) { textAdded = true; result.push({ nativeTurnId: id, nativeItemId: `${id}:text`, item: { id: `${id}:text`, type: "agentMessage", text } }); }
    if (block.type === "thinking") result.push({ nativeTurnId: id, nativeItemId: `${id}:thinking`, item: { id: `${id}:thinking`, type: "reasoning", text: block.thinking, summary: [block.thinking] } });
    if (block.type === "tool_use") result.push({ nativeTurnId: id, nativeItemId: String(block.id), item: { id: block.id, type: "mcpToolCall", server: "Claude Code", tool: block.name, arguments: block.input, status: "inProgress" } });
    if (block.type === "tool_result") result.push({ nativeTurnId: id, nativeItemId: String(block.tool_use_id), item: { id: block.tool_use_id, type: "mcpToolCall", server: "Claude Code", tool: "tool result", result: block.content, status: block.is_error ? "failed" : "completed" } });
  }
  return result;
}

interface Writer { query: Query; input: SDKUserMessage[]; wake?: () => void; closed: boolean; child?: ChildProcess; turnId?: string; interrupted: boolean; fresh: boolean; promptIds: Set<string>; completedPromptIds: Set<string>; backgroundTasks: Set<string>; backgroundSnapshotSeen: boolean; awaitingBackground: boolean; textItemId?: string; executionPermissionMode: NonNullable<ClaudeSettings["permissionMode"]>; }
interface Pending { writer: Writer; resolve: (result: PermissionResult) => void; input: Record<string, unknown>; toolName: string; }

const sshInstructions = () => sshAccess.instructions();
const defaults = { query, listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, detectClaude, nativeClaudeRunning, inspectClaudeMetadata, sshInstructions };

export class ClaudeRuntime implements AppServerClient {
  availability: ClaudeAvailability = { installed: false, version: null };
  private binary: string | undefined;
  private readonly writers = new Map<string, Writer>();
  private readonly fresh = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly owned = new Set<number>();
  private readonly nativeTasks = new Map<string, Map<string, NativeSubagent>>();
  private readonly sdk: typeof defaults;
  constructor(private readonly callbacks: AppServerCallbacks, readonly appServerEpoch: string, dependencies: Partial<typeof defaults> = {}) { this.sdk = { ...defaults, ...dependencies }; }
  private quotaAccountKey: string | undefined;
  private metadataAt = 0;
  private metadataPending: Promise<void> | undefined;
  async refreshMetadata(force = false): Promise<void> {
    if (!this.binary || (!force && Date.now()-this.metadataAt<60_000)) return;
    if(this.metadataPending)return this.metadataPending;
    this.metadataAt=Date.now();
    const binary=this.binary;
    this.metadataPending=(async()=>{
      try {
        const metadata=await this.sdk.inspectClaudeMetadata(binary,this.owned,this.availability.managed);
        if(this.binary!==binary)return;
        const quota=retainedClaudeQuota(this.availability.quota,this.quotaAccountKey,metadata);
        this.quotaAccountKey=metadata.quotaAccountKey;
        this.availability={...this.availability,quota,models:metadata.models.length ? metadata.models : this.availability.models ?? []};
      } catch {
        if(this.binary!==binary)return;
        // No verified identity: do not show a previous account's quota.
        this.quotaAccountKey=undefined;
        if(this.availability.quota)this.availability.quota={...this.availability.quota,available:false,windows:[],refreshFailed:true};
      } finally {this.metadataPending=undefined;}
    })();
    return this.metadataPending;
  }
  private discoveryGeneration = 0;
  async start() {
    const generation = ++this.discoveryGeneration;
    try {
      const { path, ...availability } = await this.sdk.detectClaude();
      if (generation !== this.discoveryGeneration) return;
      if(this.binary!==path){
        this.metadataAt=0;
        this.quotaAccountKey=undefined;
        delete this.availability.quota;
      }
      this.binary = path;
      this.availability = path ? {...this.availability,...availability,managed:availability.managed===true,steerSupported:supportsClaudeSteering(availability.version)} : availability;
      void this.refreshMetadata();
    } catch {
      if(generation!==this.discoveryGeneration)return;
      this.binary=undefined;
      this.availability={installed:false,version:null,error:"Claude 运行时不可用，请检查版本；其他智能体不受影响"};
    }
  }
  async stop() { await Promise.all([...this.writers.keys()].map(id => this.unsubscribeThread(id))); }
  private available() { if (!this.binary) throw new AgentError("CLAUDE_NOT_INSTALLED", "宿主机未安装 Claude Code"); }
  private panelTitle(id: string) {
    const thread = this.callbacks.findManagedThread(id);
    // SDK customTitle also includes aiTitle. A panel-authored name is stable
    // even when discovery later returns a generated native summary.
    return thread?.origin === "agentfleet" && thread.titleSource === "name" ? thread.title : undefined;
  }
  private sessionInfo(id: string) {
    const thread = this.callbacks.findManagedThread?.(id);
    const cwd = thread?.sessionCwd ?? (thread && this.callbacks.findProject?.(thread.projectId)?.root);
    // Unscoped SDK metadata reads only a bounded transcript head/tail. A large
    // first user record can put cwd outside that window despite a valid file.
    // Scope to the existing binding; never manufacture metadata or a new session.
    return this.sdk.getSessionInfo(nativeId(id), cwd ? { dir: cwd } : undefined);
  }
  async listThreads() {
    await this.start();
    if (!this.binary) return [];
    const running = new Map<string, Promise<boolean>>();
    const isRunning = (cwd: string) => { if (!running.has(cwd)) running.set(cwd, this.sdk.nativeClaudeRunning(cwd, this.owned)); return running.get(cwd)!; };
    const sessions = await Promise.all((await this.sdk.listSessions()).map(async s => s.cwd ? s : this.callbacks.findManagedThread?.(CLAUDE_PREFIX + s.sessionId) ? await this.sessionInfo(CLAUDE_PREFIX + s.sessionId) : s));
    return Promise.all(sessions.filter((s): s is NonNullable<typeof s> => Boolean(s?.cwd)).map(async s => ({ nativeThreadId: CLAUDE_PREFIX + s.sessionId, cwd: s.cwd!, title: this.panelTitle(CLAUDE_PREFIX + s.sessionId) ?? s.customTitle ?? (s.summary || s.firstPrompt || "Claude Code"), titleSource: this.panelTitle(CLAUDE_PREFIX + s.sessionId) || s.customTitle ? "name" as const : "preview" as const, executionState: await isRunning(s.cwd!) ? "running" as const : "idle" as const, historyMode: "paginated" as const })));
  }
  async readHistoryPage(id: string, cursor: string | null): Promise<ThreadHistoryPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentError("INVALID_CURSOR", "Invalid Claude history cursor");
    const messages = await this.sdk.getSessionMessages(nativeId(id), { offset, limit: 100, includeSystemMessages: true });
    // SDK determines the canonical parent chain; local timestamps are display metadata only.
    const info = await this.sessionInfo(id);
    const timestamps = new Map<string,string>();
    const wanted=new Set(messages.flatMap(message=>[message.uuid,...(isRecord(message.message) && typeof message.message.id === "string" ? [message.message.id] : [])]));
    if (info?.cwd && /^[a-f0-9-]{36}$/i.test(nativeId(id))) {
      const path=join(process.env.CLAUDE_CONFIG_DIR || join(homedir(),".claude"),"projects",info.cwd.replace(/[^a-zA-Z0-9]/g,"-"),nativeId(id)+".jsonl");
      try {
        await access(path);
        const lines=createInterface({input:createReadStream(path),crlfDelay:Infinity});
        for await (const line of lines) { try {
          const raw=JSON.parse(line) as Record<string,unknown>;
          if(typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp))) {
            if(typeof raw.uuid === "string" && wanted.has(raw.uuid))timestamps.set(raw.uuid,raw.timestamp);
            if(isRecord(raw.message) && typeof raw.message.id === "string" && wanted.has(raw.message.id))timestamps.set(raw.message.id,raw.timestamp);
          }
        } catch { /* Ignore non-message metadata and a partially written last line. */ } }
      } catch { /* SDK can still provide history when the local timestamp file is unavailable. */ }
    }
    const items=messages.flatMap(messageItems);
    const order=messages.flatMap((message,index)=>messageItems(message).map((entry,block)=>({itemId:entry.nativeItemId,index:(offset+index)*100+block,...(timestamps.get(message.uuid) || (isRecord(message.message) && timestamps.get(String(message.message.id))) ? {occurredAt:timestamps.get(message.uuid) || timestamps.get(String((message.message as Record<string,unknown>).id))!} : {})})));
    return { items, order, nextCursor: messages.length === 100 ? String(offset + 100) : null };
  }
  async readThread(id: string): Promise<ThreadHistorySnapshot> {
    const info = await this.sessionInfo(id);
    if (!info?.cwd && !this.fresh.has(id)) throw new AgentError("CLAUDE_SESSION_MISSING", "Claude 原会话不存在，未创建替代会话");
    const thread = this.callbacks.findManagedThread(id);
    const cwd = info?.cwd ?? thread?.sessionCwd ?? this.callbacks.findProject(thread?.projectId ?? "")?.root ?? "";
    return { nativeThreadId: id, cwd, paged: true, historyMode: "paginated", executionState: this.writers.get(id)?.turnId || await this.sdk.nativeClaudeRunning(cwd, this.owned) ? "running" : "idle", updatedAt: info?.lastModified ?? null, items: [] };
  }
  async readNativeSubagents(id: string, _project: ProjectRecord, cwd: string, childId?: string, cursor: string | null = null): Promise<NativeSubagentsPage> {
    validateSubagentRequest(childId, cursor);
    const info = await this.sdk.getSessionInfo(nativeId(id), { dir: cwd });
    if (info?.sessionId !== nativeId(id) || info.cwd !== cwd) throw new AgentError("SUBAGENTS_TARGET_CHANGED", "主会话项目已变化，请重新读取");
    const children = [...new Set(await this.sdk.listSubagents(nativeId(id), { dir: cwd }))].filter(child => /^[a-zA-Z0-9_-]{1,128}$/.test(child)).sort();
    if (!childId) {
      const offset = cursor === null ? 0 : /^list:[0-9]+$/.test(cursor) ? Number(cursor.slice(5)) : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效");
      const active = this.nativeTasks.get(id);
      // An event can arrive just before the SDK transcript is materialized.
      const ids = [...new Set([...children, ...(active?.keys() ?? [])])].sort();
      const selected = ids.slice(offset, offset + 25);
      const items = await Promise.all(selected.map(async child => {
        const task = active?.get(child);
        if (task) return task;
        const first = (await this.sdk.getSubagentMessages(nativeId(id), child, { dir: cwd, limit: 1, offset: 0 }))[0];
        const description = first ? messageItems(first).filter(entry => entry.item.type === "userMessage").map(entry => (entry.item.content as Array<{text: string}>)[0]?.text ?? "").join("\n").slice(0, 2000) : "";
        // Persisted text alone does not prove a child is still running or has completed.
        return { id: child, title: `子 Agent ${child.slice(0, 12)}`, status: "unknown", ...(description ? { description } : {}) };
      }));
      return { provider: "claude", items, nextCursor: offset + selected.length < ids.length ? `list:${offset + selected.length}` : null };
    }
    if (!children.includes(childId)) throw new AgentError("SUBAGENTS_TARGET_CHANGED", "目标不属于当前主会话的子 Agent，或记录尚未写入");
    let position: { offset: number; textOffset: number; messageId?: string } = { offset: 0, textOffset: 0 };
    if (cursor) {
      try { position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效"); }
      if (!isRecord(position) || !Number.isSafeInteger(position.offset) || position.offset < 0 || !Number.isSafeInteger(position.textOffset) || position.textOffset < 0 || (position.messageId !== undefined && typeof position.messageId !== "string")) throw new AgentError("SUBAGENTS_CURSOR_INVALID", "分工读取位置无效");
    }
    const raw = await this.sdk.getSubagentMessages(nativeId(id), childId, { dir: cwd, offset: position.offset, limit: 20 });
    const messages: NativeSubagentMessage[] = [];
    let consumed = 0, characters = 0, continuation: typeof position | null = null;
    for (const message of raw) {
      if (characters >= 80000) { continuation = { offset: position.offset + consumed, textOffset: 0 }; break; }
      const entries = messageItems(message).filter(entry => ["userMessage", "agentMessage"].includes(String(entry.item.type)));
      if (!entries.length) { consumed++; continue; }
      const entry = entries[0]!;
      const text = entry.item.type === "agentMessage" ? String(entry.item.text ?? "") : (entry.item.content as Array<{text: string}>).map(block => block.text).join("\n");
      const start = consumed === 0 ? position.textOffset : 0;
      if (start > text.length || (consumed === 0 && position.messageId && position.messageId !== entry.nativeItemId)) throw new AgentError("SUBAGENTS_CURSOR_INVALID", "原生对话已变化，请重新读取");
      const part = text.slice(start, start + 20000);
      messages.push({ id: entry.nativeItemId, role: entry.item.type === "userMessage" ? "user" : "assistant", text: part, textOffset: start, textLength: text.length, truncated: start > 0 || part.length < text.length, status: this.nativeTasks.get(id)?.get(childId)?.status ?? "unknown" });
      characters += part.length;
      if (start + part.length < text.length) { continuation = { offset: position.offset + consumed, textOffset: start + part.length, messageId: entry.nativeItemId }; break; }
      consumed++;
    }
    continuation ??= consumed === 20 ? { offset: position.offset + consumed, textOffset: 0 } : null;
    return { provider: "claude", items: [], childId, messages, nextCursor: continuation ? Buffer.from(JSON.stringify(continuation)).toString("base64url") : null };
  }

  private observeNativeTask(id: string, message: unknown): void {
    if (!isRecord(message) || message.type !== "system" || message.session_id !== nativeId(id) || typeof message.task_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.task_id)) return;
    if (message.skip_transcript === true || message.ambient === true) {
      this.nativeTasks.get(id)?.delete(message.task_id);
      return;
    }
    const existing = this.nativeTasks.get(id)?.get(message.task_id);
    // Only a visible start registers a task. Later progress may omit ambient
    // flags, so it cannot reintroduce a filtered internal worker on its own.
    const isAgent = message.subtype === "task_started" && (message.task_type === "local_agent" || typeof message.subagent_type === "string");
    if (!existing && !isAgent) return; // Background Bash and MCP jobs are not child Agents.
    const tasks = this.nativeTasks.get(id) ?? new Map<string, NativeSubagent>();
    const patch = isRecord(message.patch) ? message.patch : {};
    const status = message.subtype === "task_notification" ? message.status : message.subtype === "task_updated" ? patch.status : "running";
    tasks.set(message.task_id, { id: message.task_id, title: String(message.subagent_type ?? existing?.title ?? `子 Agent ${message.task_id.slice(0, 12)}`).slice(0, 200), status: typeof status === "string" ? status.slice(0, 60) : existing?.status ?? "unknown", description: String(message.summary ?? message.description ?? patch.description ?? existing?.description ?? "").slice(0, 2000) });
    while (tasks.size > 200) tasks.delete(tasks.keys().next().value!);
    this.nativeTasks.set(id, tasks);
    while (this.nativeTasks.size > 64) this.nativeTasks.delete(this.nativeTasks.keys().next().value!);
  }
  private loseNativeTaskObservation(id: string): void {
    const tasks = this.nativeTasks.get(id);
    if (!tasks) return;
    for (const [taskId, task] of tasks) {
      if (!["completed", "failed", "stopped", "killed"].includes(task.status)) tasks.set(taskId, { ...task, status: "unknown" });
    }
  }
  async readTurnOutcome(id: string, turnId: string): Promise<{cwd:string;status:string} | null> {
    const thread = this.callbacks.findManagedThread(id);
    const cwd = thread?.sessionCwd ?? this.callbacks.findProject(thread?.projectId ?? "")?.root;
    if (!cwd || thread?.lastTurnId !== turnId || !["completed","failed","interrupted"].includes(thread.lastTurnStatus ?? "") || await this.sdk.nativeClaudeRunning(cwd,this.owned)) return null;
    return {cwd,status:thread.lastTurnStatus!};
  }
  async createThread(_project: ProjectRecord, _profile?: PermissionProfile, _name?: string) {
    this.available(); const id = CLAUDE_PREFIX + randomUUID(); this.fresh.add(id);
    return { nativeThreadId: id, policyVerified: true, historyMode: "paginated" as const, rawSummary: {} };
  }
  async resumeThread(id: string, project: ProjectRecord, cwd = project.root, _profile?: PermissionProfile) {
    this.available();
    if (await this.sdk.nativeClaudeRunning(cwd, this.owned)) throw new AgentError("CLAUDE_HOST_BUSY", "该目录的 Claude 终端仍在运行；退出终端后即可继续原会话");
    const history = await this.readThread(id);
    if (history.cwd !== cwd) throw new AgentError("THREAD_CWD_MISMATCH", "Claude 会话目录已变化");
    return { nativeThreadId: id, policyVerified: true, historyMode: "paginated" as const, rawSummary: {}, history };
  }
  async unsubscribeThread(id: string) {
    const writer = this.writers.get(id); if (!writer) return;
    writer.closed = true; writer.wake?.();
    this.loseNativeTaskObservation(id);
    for (const [key, pending] of this.pending) if (pending.writer === writer) { pending.resolve({ behavior: "deny", message: "会话执行连接已释放" }); this.pending.delete(key); }
    const child = writer.child;
    const exited = child && child.exitCode === null && child.signalCode === null ? new Promise<void>(resolve => child.once("close", () => resolve())) : Promise.resolve();
    writer.query.close();
    await Promise.race([exited, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new AgentError("THREAD_RELEASE_PENDING", "Claude 执行进程尚未退出")), 5000); timer.unref(); })]);
    this.writers.delete(id);
  }
  async startTurn(thread: ManagedThread, project: ProjectRecord, prompt: string, _clientUserMessageId?: string, settings?: CodexSettings, images?: string[], extras?: TurnExtras) {
    this.available();
    if (await this.sdk.nativeClaudeRunning(thread.sessionCwd ?? project.root, this.owned)) throw new AgentError("CLAUDE_HOST_BUSY", "Claude 终端仍在运行，退出后可继续原会话");
    if (this.writers.has(thread.nativeThreadId)) throw new AgentError("THREAD_BUSY", "Claude 会话仍在运行");
    const fleetHosts = await this.sdk.sshInstructions();
    const id = thread.nativeThreadId;
    const turnId = randomUUID();
    const writer = { input: [], closed: false, interrupted: false, fresh: this.fresh.has(id), promptIds: new Set<string>(), completedPromptIds: new Set<string>(), backgroundTasks: new Set<string>(), backgroundSnapshotSeen: false, awaitingBackground: false, turnId, executionPermissionMode: (settings as ClaudeSettings | undefined)?.permissionMode ?? "default" } as unknown as Writer;
    const callbacks = this.callbacks, epoch = this.appServerEpoch;
    // The SDK need not echo submitted user messages. Record each consumed input
    // with its native UUID, also used by history/echo deduplication.
    const input = async function* () {
      while (!writer.closed) {
        const message = writer.input.shift();
        if (message) {
          for (const entry of messageItems(message)) {
            await callbacks.onEvent({type:"item.completed",nativeThreadId:id,nativeTurnId:turnId,nativeItemId:entry.nativeItemId,payload:{item:entry.item}},epoch);
          }
          yield message;
        } else await new Promise<void>(resolve => { writer.wake = resolve; });
      }
    };
    const options: Options = {
      cwd: thread.sessionCwd ?? project.root, pathToClaudeCodeExecutable: this.binary!,
      ...(this.availability.managed ? {env:{...process.env,DISABLE_AUTOUPDATER:"1"}} : {}),
      settingSources: ["user", "project", "local"], systemPrompt: { type: "preset", preset: "claude_code", ...(fleetHosts ? { append: fleetHosts } : {}) },
      // Establish the selected execution permission first. Starting directly in
      // plan loses it: the native CLI has no auto/acceptEdits mode to return to.
      // Enter plan via the SDK below, before any user input can be consumed.
      includePartialMessages: true, permissionMode: writer.executionPermissionMode, permissionPrompts: "host",
      ...(writer.fresh ? { sessionId: nativeId(id), ...(thread.titleSource === "name" && thread.title ? { title: thread.title } : {}) } : { resume: nativeId(id) }),
      ...(settings?.model && settings.model !== "host" ? { model: settings.model } : {}),
      ...(settings?.effort ? { effort: settings.effort as NonNullable<Options["effort"]> } : {}),
      canUseTool: async (name, input, context) => {
        const approvalId = randomUUID();
        const questions = name === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions.filter(isRecord).map((q, index) => ({ ...q, id: String(index), isOther: true })) : undefined;
        const params = questions ? { kind: "user_input", questions, isBlocking: true } : { threadId: id, turnId, toolName: name, input, reason: context.decisionReason?.slice(0, 4000) || `${name}: ${JSON.stringify(input).slice(0, 4000)}`, ...(name === "ExitPlanMode" ? { executionPermissionMode: writer.executionPermissionMode } : {}), ...(name === "Bash" ? { command: input.command } : {}) };
        const method = questions ? "item/tool/requestUserInput" : "item/commandExecution/requestApproval";
        const approval: ApprovalRecord = { approvalId, nativeRequestId: approvalId, method, actionHash: sha256(canonicalJson(params)), appServerEpoch: this.appServerEpoch, projectId: project.id, nativeThreadId: id, nativeTurnId: turnId, ...(context.toolUseID ? { nativeItemId: context.toolUseID } : {}), expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "pending", params, createdAt: nowIso(), updatedAt: nowIso() };
        return new Promise<PermissionResult>((resolve, reject) => {
          const settle = (result: PermissionResult) => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); resolve(result); };
          const abort = () => { this.pending.delete(approvalId); settle({ behavior: "deny", message: "任务已取消" }); void this.callbacks.onApprovalResolved(approvalId, this.appServerEpoch).catch(() => undefined); };
          const timer = setTimeout(() => { if (!this.pending.delete(approvalId)) return; settle({ behavior: "deny", message: "审批已过期" }); void this.callbacks.onApprovalResolved(approvalId, this.appServerEpoch).catch(() => undefined); }, 600_000);
          timer.unref();
          this.pending.set(approvalId, { writer, resolve: settle, input, toolName: name });
          if (context.signal.aborted) { abort(); return; }
          context.signal.addEventListener("abort", abort, { once: true });
          void this.callbacks.onApproval(approval).catch(error => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); this.pending.delete(approvalId); reject(error); });
        });
      },
      spawnClaudeCodeProcess: config => {
        // Never copy or upload credentials: the CLI reads the host user's login.
        const child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, signal: config.signal });
        child.stderr.on("data", () => { /* Drain native diagnostics to prevent subprocess backpressure. */ });
        writer.child = child; if (child.pid) this.owned.add(child.pid);
        child.once("close", () => { if (child.pid) this.owned.delete(child.pid); });
        return child;
      },
    };
    writer.query = this.sdk.query({ prompt: input(), options }); this.writers.set(id, writer);
    if (settings?.mode === "plan") {
      try {
        await writer.query.setPermissionMode("plan");
        if (writer.closed) throw new AgentError("THREAD_RELEASE_PENDING", "Claude 会话在进入计划模式时已释放");
      } catch (error) {
        await this.unsubscribeThread(id);
        throw error;
      }
    }
    const content: SDKUserMessage["message"]["content"] = [{ type: "text", text: prompt + (extras?.goal ? `\n\n会话目标：${extras.goal}` : "") + (extras?.attachments?.length ? `\n\n附件路径：\n${extras.attachments.map(f => f.path).join("\n")}` : "") }];
    for (const url of images ?? []) { const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url); if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2]! } }); }
    const promptId = randomUUID(); writer.promptIds.add(promptId);
    writer.input.push({ type: "user", uuid: promptId, session_id: nativeId(id), parent_tool_use_id: null, message: { role: "user", content } });
    writer.wake?.();
    setImmediate(() => void this.pump(id, writer).catch(() => undefined));
    return { nativeTurnId: turnId, status: "inProgress" };
  }
  private async pump(id: string, writer: Writer) {
    const turnId = writer.turnId!;
    const emit = (type: string, payload: Record<string, unknown>, itemId?: string) => this.callbacks.onEvent({ type, payload, nativeThreadId: id, nativeTurnId: turnId, ...(itemId ? { nativeItemId: itemId } : {}) }, this.appServerEpoch);
    try {
      for await (const msg of writer.query) {
        if (this.writers.get(id) !== writer || writer.closed) break;
        this.observeNativeTask(id, msg);
        // A child's stream, assistant reply, or result belongs to its native
        // transcript. It must never alter the parent's text id or finish its turn.
        const rawMessage: unknown = msg;
        if (isRecord(rawMessage) && (typeof rawMessage.parent_tool_use_id === "string" || typeof rawMessage.parent_agent_id === "string")) continue;
        if (isRecord(rawMessage) && rawMessage.type === "system" && rawMessage.session_id === nativeId(id)) {
          // Native idle is emitted after the held result is flushed and the
          // background-agent loop exits. There need not be another attributed
          // parent result. Only release an already acknowledged turn: startup
          // idle or idle preceding an accepted follow-up must not lose input.
          if (rawMessage.subtype === "session_state_changed" && rawMessage.state === "idle" && writer.awaitingBackground && writer.promptIds.size === 0) {
            delete writer.turnId;
            await emit("turn.completed", { turn: { id: turnId, status: writer.interrupted ? "interrupted" : "completed" } });
            break;
          }
          if (rawMessage.subtype === "background_tasks_changed" && Array.isArray(rawMessage.tasks)) {
            // Native snapshots are authoritative. Their order relative to edge
            // events is unspecified; never merge late edges into a snapshot.
            writer.backgroundSnapshotSeen = true;
            writer.backgroundTasks = new Set(rawMessage.tasks.filter(isRecord).filter(task => task.ambient !== true && task.task_type === "local_agent" && typeof task.task_id === "string").map(task => task.task_id as string));
          } else if (!writer.backgroundSnapshotSeen && typeof rawMessage.task_id === "string") {
            const task = this.nativeTasks.get(id)?.get(rawMessage.task_id);
            const status = rawMessage.subtype === "task_notification" ? rawMessage.status : isRecord(rawMessage.patch) ? rawMessage.patch.status : task?.status;
            if (rawMessage.ambient === true || rawMessage.skip_transcript === true || typeof status === "string" && ["completed", "failed", "stopped", "killed"].includes(status)) writer.backgroundTasks.delete(rawMessage.task_id);
            else if (task) writer.backgroundTasks.add(rawMessage.task_id);
          }
        }
        if (msg.type === "system" && msg.subtype === "init") {
          if (CLAUDE_PREFIX + msg.session_id !== id) throw new AgentError("CLAUDE_RESUME_MISMATCH", "Claude 返回了不同会话，已停止执行");
          this.fresh.delete(id);
        }
        if (msg.type === "stream_event" && msg.event.type === "message_start") writer.textItemId = `${msg.event.message.id}:text`;
        if (msg.type === "stream_event" && msg.event.type === "content_block_delta" && msg.event.delta.type === "text_delta") this.callbacks.onVolatile({ type: "agent_message.delta", payload: { delta: msg.event.delta.text }, nativeThreadId: id, nativeTurnId: turnId, nativeItemId: writer.textItemId ?? `${msg.uuid}:text` }, this.appServerEpoch);
        if (msg.type === "assistant" || msg.type === "user") {
          const entries = messageItems(msg);
          if (entries.length > 1 && this.callbacks.onEvents) await this.callbacks.onEvents(entries.map(entry => ({ type: "item.completed", payload: { item: entry.item }, nativeThreadId: id, nativeTurnId: turnId, nativeItemId: entry.nativeItemId })), this.appServerEpoch);
          else for (const entry of entries) await emit("item.completed", { item: entry.item }, entry.nativeItemId);
        }
        if (msg.type === "result") {
          // A resumed CLI may finish an old background/meta turn before it
          // consumes our queued prompt. Closing on that result loses the send.
          // Match all consumed UUIDs because the CLI can merge prompt batches.
          const ids = [...(msg.user_message_uuids ?? []), ...(msg.user_message_uuid ? [msg.user_message_uuid] : [])];
          const matches = ids.some(uuid => writer.promptIds.has(uuid));
          const continuation = writer.awaitingBackground && msg.num_turns > 0 && (ids.length === 0 || ids.some(uuid => writer.completedPromptIds.has(uuid)));
          const attributesPrompts = supportsClaudeSteering(this.availability.version);
          if (!matches && !continuation && (ids.length > 0 || (!msg.is_error && !writer.interrupted && (attributesPrompts || (msg.queued_turn_count ?? 0) > 0 || msg.num_turns === 0)))) continue;
          for (const uuid of ids) if (writer.promptIds.delete(uuid)) writer.completedPromptIds.add(uuid);
          // Unattributed fatal startup errors and interrupt results still end
          // the attempt; older CLIs without attribution retain legacy behavior.
          // Native modelUsage is conversation-cumulative; usage is this query's consumption.
          const models=Object.values(msg.modelUsage);
          const inputTokens=models.reduce((sum,model)=>sum+model.inputTokens+model.cacheCreationInputTokens+model.cacheReadInputTokens,0);
          const outputTokens=models.reduce((sum,model)=>sum+model.outputTokens,0);
          const total={inputTokens,outputTokens,cachedInputTokens:models.reduce((sum,model)=>sum+model.cacheReadInputTokens,0),reasoningOutputTokens:models.reduce((sum,model)=>sum+(model.thinkingTokens ?? 0),0),totalTokens:inputTokens+outputTokens};
          const lastInput=msg.usage.input_tokens+(msg.usage.cache_creation_input_tokens ?? 0)+(msg.usage.cache_read_input_tokens ?? 0);
          const last={inputTokens:lastInput,outputTokens:msg.usage.output_tokens,cachedInputTokens:msg.usage.cache_read_input_tokens ?? 0,reasoningOutputTokens:msg.usage.output_tokens_details?.thinking_tokens ?? 0,totalTokens:lastInput+msg.usage.output_tokens};
          await emit("thread.usage", { usage: { total, last } });
          if (msg.is_error) await emit("turn.error", { message: "errors" in msg ? msg.errors.join("\n") : "Claude 执行失败" });
          // A later native result may cover an input accepted near the end of this one.
          // Keep reading the SAME query until all accepted inputs are accounted for.
          if (!msg.is_error && !writer.interrupted && attributesPrompts && writer.promptIds.size > 0) continue;
          if (!msg.is_error && !writer.interrupted && (writer.backgroundTasks.size > 0 || (msg.queued_turn_count ?? 0) > 0)) {
            writer.awaitingBackground = true;
            // Keep the same query alive for native child completion and the
            // parent's follow-up, including an already queued notification
            // after the last child exits. A main-loop result is not completion.
            continue;
          }
          delete writer.turnId;
          await emit("turn.completed", { turn: { id: turnId, status: writer.interrupted ? "interrupted" : msg.is_error ? "failed" : "completed" } });
          break;
        }
      }
      if (writer.turnId && !writer.closed) throw new Error("Claude 进程退出，未返回任务完成结果");
    } catch (error) {
      if (!writer.closed) { delete writer.turnId; await emit("turn.error", { message: error instanceof Error ? error.message : "Claude 执行失败" }); await emit("turn.completed", { turn: { id: turnId, status: "failed" } }); }
    } finally {
      // Parent result, interruption, stream failure, and release all end our
      // observation. Do not pretend unreported child outcomes are still live.
      // An old pump must not overwrite a replacement writer's fresh task state.
      if (this.writers.get(id) === writer) this.loseNativeTaskObservation(id);
    }
  }
  async steerTurn(thread: ManagedThread, turnId: string, prompt: string, clientUserMessageId?: string, images?: string[], extras?: TurnExtras) {
    if (!this.availability.steerSupported) throw new AgentError("AGENT_CAPABILITY_UNAVAILABLE", "当前 Claude 版本尚未验证原生追加能力，请加入队列");
    const writer = this.writers.get(thread.nativeThreadId);
    if (!writer || writer.closed || writer.interrupted || writer.turnId !== turnId) throw new AgentError("TURN_PRECONDITION_FAILED", "Claude 原任务已经变化，补充消息未发送");
    if (extras?.pluginSkills?.length || extras?.outputSchema) throw new AgentError("AGENT_INPUT_UNSUPPORTED", "原生追加不支持这些输入，消息未发送");
    const content: SDKUserMessage["message"]["content"] = [{type:"text",text:prompt + (extras?.goal ? `\n\n会话目标：${extras.goal}` : "") + (extras?.attachments?.length ? `\n\n附件路径：\n${extras.attachments.map(f=>f.path).join("\n")}` : "")}];
    for (const url of parseImages(images)) {
      const comma=url.indexOf(',');
      content.push({type:"image",source:{type:"base64",media_type:url.slice(5,url.indexOf(';')) as "image/png",data:url.slice(comma+1)}});
    }
    const promptId = clientUserMessageId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientUserMessageId) ? clientUserMessageId as ReturnType<typeof randomUUID> : randomUUID();
    if (writer.promptIds.has(promptId)) return {nativeTurnId:turnId,status:"inProgress"};
    writer.promptIds.add(promptId);
    writer.input.push({ type: "user", uuid: promptId, session_id: nativeId(thread.nativeThreadId), parent_tool_use_id: null, message: { role: "user", content } }); writer.wake?.();
    return { nativeTurnId: turnId, status: "inProgress" };
  }
  async interruptTurn(id: string, turnId: string) { const writer = this.writers.get(id); if (!writer || writer.turnId !== turnId) throw new AgentError("TURN_PRECONDITION_FAILED", "任务已经变化"); writer.interrupted = true; await writer.query.interrupt(); return {}; }
  async respondApproval(approval: ApprovalRecord, decision: "accept" | "decline" | "cancel") {
    const pending = this.pending.get(approval.approvalId);
    if (!pending) throw new AgentError("APPROVAL_EPOCH_STALE", "审批已失效");
    this.pending.delete(approval.approvalId);
    pending.resolve(decision === "accept" ? {
      behavior: "allow", updatedInput: pending.input,
      // Only an explicitly approved plan exit restores the permission selected
      // when this turn started. Never adopt arbitrary CLI suggestions, persist
      // allow rules, or treat ordinary tool approvals as blanket authorization.
      ...(pending.toolName === "ExitPlanMode" ? { updatedPermissions: [{
        type: "setMode" as const, mode: pending.writer.executionPermissionMode, destination: "session" as const,
      }] } : {}),
    } : { behavior: "deny", message: "用户拒绝执行", interrupt: decision === "cancel" });
  }
  async respondInput(approval: ApprovalRecord, answers: InputAnswers) { const pending = this.pending.get(approval.approvalId); if (!pending) throw new AgentError("APPROVAL_EPOCH_STALE", "提问已失效"); this.pending.delete(approval.approvalId); const questions = Array.isArray(pending.input.questions) ? pending.input.questions.filter(isRecord) : []; const mapped = Object.fromEntries(questions.map((q, index) => [String(q.question), answers[String(index)]?.answers.join(", ") ?? ""])); pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: mapped } }); }
}
