import { type ClaudeSettings } from "./claude-settings.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { access, readlink, readdir, readFile } from "node:fs/promises";
import { delimiter, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { query, listSessions, getSessionInfo, getSessionMessages, type Query, type SDKUserMessage, type PermissionResult, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerClient, AppServerCallbacks, ThreadHistorySnapshot, ThreadHistoryPage } from "./app-server.js";
import type { ManagedThread, ProjectRecord, ApprovalRecord } from "./types.js";
import type { CodexSettings } from "./codex-settings.js";
import type { PermissionProfile } from "./permissions.js";
import type { TurnExtras } from "./attachments.js";
import type { InputAnswers } from "./user-input.js";
import { AgentError } from "./errors.js";
import { isRecord, nowIso, sha256, canonicalJson } from "./util.js";

import { inspectClaudeMetadata, type ClaudeModel, type ClaudeQuota } from "./claude-metadata.js";

export const CLAUDE_PREFIX = "claude_";
export const isClaudeThread = (id: string) => id.startsWith(CLAUDE_PREFIX);
export const isClaudeProject = (project: ProjectRecord) => project.provider === "claude";
const nativeId = (id: string) => id.slice(CLAUDE_PREFIX.length);
const execFileAsync = promisify(execFile);
export interface ClaudeAvailability { installed: boolean; version: string | null; error?: string; models?: ClaudeModel[]; quota?: ClaudeQuota; permissionModes?: string[]; }

export async function detectClaude(): Promise<ClaudeAvailability & { path?: string }> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...new Set([...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute), join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin"), ...(process.platform === "win32" ? [join(homedir(), "AppData", "Roaming", "npm")] : ["/usr/local/bin", "/opt/homebrew/bin"])])];
  for (const dir of dirs) for (const name of names) {
    const path = join(dir, name);
    try {
      await access(path);
      const executable = name.endsWith(".cmd") ? join(dir,"node_modules","@anthropic-ai","claude-code","cli.js") : path;
      const result = await execFileAsync(name.endsWith(".cmd") ? process.execPath : executable, name.endsWith(".cmd") ? [executable,"--version"] : ["--version"], { timeout: 5000, windowsHide: true });
      let permissionModes:string[]=[];
      try {
        const help=await execFileAsync(name.endsWith(".cmd") ? process.execPath : executable,name.endsWith(".cmd")?[executable,"--help"]:["--help"],{timeout:5000,windowsHide:true});
        const choices=/--permission-mode\s+<mode>[\s\S]*?choices:\s*([^)]*)/u.exec(help.stdout)?.[1] ?? "";
        permissionModes=["default","auto","acceptEdits","dontAsk"].filter(mode=>choices.includes(`"${mode === "default" ? "manual" : mode}"`) || choices.includes(`"${mode}"`));
      } catch { /* Older CLI stays usable with its existing permission behavior. */ }
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
  let textAdded = false;
  for (const block of blocks) {
    if (block.type === "text" && text && !textAdded) { textAdded = true; result.push({ nativeTurnId: id, nativeItemId: `${id}:text`, item: value.type === "user"
    ? { id: `${id}:text`, type: "userMessage", content: [{ type: "text", text }] }
    : { id: `${id}:text`, type: "agentMessage", text } }); }
    if (block.type === "thinking") result.push({ nativeTurnId: id, nativeItemId: `${id}:thinking`, item: { id: `${id}:thinking`, type: "reasoning", text: block.thinking, summary: [block.thinking] } });
    if (block.type === "tool_use") result.push({ nativeTurnId: id, nativeItemId: String(block.id), item: { id: block.id, type: "mcpToolCall", server: "Claude Code", tool: block.name, arguments: block.input, status: "inProgress" } });
    if (block.type === "tool_result") result.push({ nativeTurnId: id, nativeItemId: String(block.tool_use_id), item: { id: block.tool_use_id, type: "mcpToolCall", server: "Claude Code", tool: "tool result", result: block.content, status: block.is_error ? "failed" : "completed" } });
  }
  return result;
}

interface Writer { query: Query; input: SDKUserMessage[]; wake?: () => void; closed: boolean; child?: ChildProcess; turnId?: string; interrupted: boolean; fresh: boolean; textItemId?: string; }
interface Pending { writer: Writer; resolve: (result: PermissionResult) => void; input: Record<string, unknown>; }

const defaults = { query, listSessions, getSessionInfo, getSessionMessages, detectClaude, nativeClaudeRunning, inspectClaudeMetadata };

export class ClaudeRuntime implements AppServerClient {
  availability: ClaudeAvailability = { installed: false, version: null };
  private binary: string | undefined;
  private readonly writers = new Map<string, Writer>();
  private readonly fresh = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly owned = new Set<number>();
  private readonly sdk: typeof defaults;
  constructor(private readonly callbacks: AppServerCallbacks, readonly appServerEpoch: string, dependencies: Partial<typeof defaults> = {}) { this.sdk = { ...defaults, ...dependencies }; }
  private metadataAt = 0;
  private metadataPending: Promise<void> | undefined;
  async refreshMetadata(force = false): Promise<void> {
    if (!this.binary || (!force && Date.now()-this.metadataAt<60_000)) return;
    if(this.metadataPending)return this.metadataPending;
    this.metadataAt=Date.now();
    this.metadataPending=(async()=>{try {const metadata=await this.sdk.inspectClaudeMetadata(this.binary!,this.owned);this.availability={...this.availability,...metadata,models:metadata.models.length ? metadata.models : this.availability.models ?? []};} catch {if(this.availability.quota)this.availability.quota={...this.availability.quota,available:false,windows:[]};}finally{this.metadataPending=undefined;}})();
    return this.metadataPending;
  }
  async start() { const { path, ...availability } = await this.sdk.detectClaude(); this.binary = path; this.availability = path ? {...this.availability,...availability} : availability; void this.refreshMetadata(); }
  async stop() { await Promise.all([...this.writers.keys()].map(id => this.unsubscribeThread(id))); }
  private available() { if (!this.binary) throw new AgentError("CLAUDE_NOT_INSTALLED", "宿主机未安装 Claude Code"); }
  async listThreads() {
    await this.start();
    if (!this.binary) return [];
    const running = new Map<string, Promise<boolean>>();
    const isRunning = (cwd: string) => { if (!running.has(cwd)) running.set(cwd, this.sdk.nativeClaudeRunning(cwd, this.owned)); return running.get(cwd)!; };
    return Promise.all((await this.sdk.listSessions()).filter(s => s.cwd).map(async s => ({ nativeThreadId: CLAUDE_PREFIX + s.sessionId, cwd: s.cwd!, title: s.summary || s.firstPrompt || "Claude Code", titleSource: s.customTitle ? "name" as const : "preview" as const, executionState: await isRunning(s.cwd!) ? "running" as const : "idle" as const, historyMode: "paginated" as const })));
  }
  async readHistoryPage(id: string, cursor: string | null): Promise<ThreadHistoryPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AgentError("INVALID_CURSOR", "Invalid Claude history cursor");
    const messages = await this.sdk.getSessionMessages(nativeId(id), { offset, limit: 100, includeSystemMessages: true });
    // SDK determines the canonical parent chain; local timestamps are display metadata only.
    const info = await this.sdk.getSessionInfo(nativeId(id));
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
    const info = await this.sdk.getSessionInfo(nativeId(id));
    if (!info?.cwd && !this.fresh.has(id)) throw new AgentError("CLAUDE_SESSION_MISSING", "Claude 原会话不存在，未创建替代会话");
    const thread = this.callbacks.findManagedThread(id);
    const cwd = info?.cwd ?? thread?.sessionCwd ?? this.callbacks.findProject(thread?.projectId ?? "")?.root ?? "";
    return { nativeThreadId: id, cwd, paged: true, historyMode: "paginated", executionState: this.writers.get(id)?.turnId || await this.sdk.nativeClaudeRunning(cwd, this.owned) ? "running" : "idle", updatedAt: info?.lastModified ?? null, items: [] };
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
    const id = thread.nativeThreadId;
    const turnId = randomUUID();
    const writer = { input: [], closed: false, interrupted: false, fresh: this.fresh.has(id), turnId } as unknown as Writer;
    const input = async function* () { while (!writer.closed) { const message = writer.input.shift(); if (message) yield message; else await new Promise<void>(resolve => { writer.wake = resolve; }); } };
    const options: Options = {
      cwd: thread.sessionCwd ?? project.root, pathToClaudeCodeExecutable: this.binary!,
      settingSources: ["user", "project", "local"], systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true, permissionMode: settings?.mode === "plan" ? "plan" : (settings as ClaudeSettings|undefined)?.permissionMode ?? "default", permissionPrompts: "host",
      ...(writer.fresh ? { sessionId: nativeId(id) } : { resume: nativeId(id) }),
      ...(settings?.model && settings.model !== "host" ? { model: settings.model } : {}),
      ...(settings?.effort ? { effort: settings.effort as NonNullable<Options["effort"]> } : {}),
      canUseTool: async (name, input, context) => {
        const approvalId = randomUUID();
        const questions = name === "AskUserQuestion" && Array.isArray(input.questions) ? input.questions.filter(isRecord).map((q, index) => ({ ...q, id: String(index), isOther: true })) : undefined;
        const params = questions ? { kind: "user_input", questions, isBlocking: true } : { threadId: id, turnId, toolName: name, input, reason: `${name}: ${JSON.stringify(input).slice(0, 4000)}`, ...(name === "Bash" ? { command: input.command } : {}) };
        const method = questions ? "item/tool/requestUserInput" : "item/commandExecution/requestApproval";
        const approval: ApprovalRecord = { approvalId, nativeRequestId: approvalId, method, actionHash: sha256(canonicalJson(params)), appServerEpoch: this.appServerEpoch, projectId: project.id, nativeThreadId: id, nativeTurnId: turnId, ...(context.toolUseID ? { nativeItemId: context.toolUseID } : {}), expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "pending", params, createdAt: nowIso(), updatedAt: nowIso() };
        return new Promise<PermissionResult>((resolve, reject) => {
          const settle = (result: PermissionResult) => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); resolve(result); };
          const abort = () => { this.pending.delete(approvalId); settle({ behavior: "deny", message: "任务已取消" }); void this.callbacks.onApprovalResolved(approvalId, this.appServerEpoch).catch(() => undefined); };
          const timer = setTimeout(() => { if (!this.pending.delete(approvalId)) return; settle({ behavior: "deny", message: "审批已过期" }); void this.callbacks.onApprovalResolved(approvalId, this.appServerEpoch).catch(() => undefined); }, 600_000);
          timer.unref();
          this.pending.set(approvalId, { writer, resolve: settle, input });
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
    const content: SDKUserMessage["message"]["content"] = [{ type: "text", text: prompt + (extras?.goal ? `\n\n会话目标：${extras.goal}` : "") + (extras?.attachments?.length ? `\n\n附件路径：\n${extras.attachments.map(f => f.path).join("\n")}` : "") }];
    for (const url of images ?? []) { const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url); if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2]! } }); }
    writer.input.push({ type: "user", uuid: randomUUID(), session_id: nativeId(id), parent_tool_use_id: null, message: { role: "user", content } });
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
        if (msg.type === "system" && msg.subtype === "init") {
          if (CLAUDE_PREFIX + msg.session_id !== id) throw new AgentError("CLAUDE_RESUME_MISMATCH", "Claude 返回了不同会话，已停止执行");
          this.fresh.delete(id);
        }
        if (msg.type === "stream_event" && msg.event.type === "message_start") writer.textItemId = `${msg.event.message.id}:text`;
        if (msg.type === "stream_event" && msg.event.type === "content_block_delta" && msg.event.delta.type === "text_delta") this.callbacks.onVolatile({ type: "agent_message.delta", payload: { delta: msg.event.delta.text }, nativeThreadId: id, nativeTurnId: turnId, nativeItemId: writer.textItemId ?? `${msg.uuid}:text` }, this.appServerEpoch);
        if (msg.type === "assistant" || msg.type === "user") for (const entry of messageItems(msg)) await emit("item.completed", { item: entry.item }, entry.nativeItemId);
        if (msg.type === "result") {
          // Native modelUsage is conversation-cumulative; usage is this query's consumption.
          const models=Object.values(msg.modelUsage);
          const inputTokens=models.reduce((sum,model)=>sum+model.inputTokens+model.cacheCreationInputTokens+model.cacheReadInputTokens,0);
          const outputTokens=models.reduce((sum,model)=>sum+model.outputTokens,0);
          const total={inputTokens,outputTokens,cachedInputTokens:models.reduce((sum,model)=>sum+model.cacheReadInputTokens,0),reasoningOutputTokens:models.reduce((sum,model)=>sum+(model.thinkingTokens ?? 0),0),totalTokens:inputTokens+outputTokens};
          const lastInput=msg.usage.input_tokens+(msg.usage.cache_creation_input_tokens ?? 0)+(msg.usage.cache_read_input_tokens ?? 0);
          const last={inputTokens:lastInput,outputTokens:msg.usage.output_tokens,cachedInputTokens:msg.usage.cache_read_input_tokens ?? 0,reasoningOutputTokens:msg.usage.output_tokens_details?.thinking_tokens ?? 0,totalTokens:lastInput+msg.usage.output_tokens};
          await emit("thread.usage", { usage: { total, last } });
          if (msg.is_error) await emit("turn.error", { message: "errors" in msg ? msg.errors.join("\n") : "Claude 执行失败" });
          delete writer.turnId;
          await emit("turn.completed", { turn: { id: turnId, status: writer.interrupted ? "interrupted" : msg.is_error ? "failed" : "completed" } });
          break;
        }
      }
      if (writer.turnId && !writer.closed) throw new Error("Claude 进程退出，未返回任务完成结果");
    } catch (error) {
      if (!writer.closed) { delete writer.turnId; await emit("turn.error", { message: error instanceof Error ? error.message : "Claude 执行失败" }); await emit("turn.completed", { turn: { id: turnId, status: "failed" } }); }
    }
  }
  async steerTurn(thread: ManagedThread, turnId: string, prompt: string, _clientUserMessageId?: string) {
    const writer = this.writers.get(thread.nativeThreadId); if (!writer || writer.turnId !== turnId) throw new AgentError("THREAD_BUSY", "Claude 没有正在运行的任务");
    writer.input.push({ type: "user", uuid: randomUUID(), session_id: nativeId(thread.nativeThreadId), parent_tool_use_id: null, message: { role: "user", content: prompt } }); writer.wake?.();
    return { nativeTurnId: turnId, status: "inProgress" };
  }
  async interruptTurn(id: string, turnId: string) { const writer = this.writers.get(id); if (!writer || writer.turnId !== turnId) throw new AgentError("TURN_PRECONDITION_FAILED", "任务已经变化"); writer.interrupted = true; await writer.query.interrupt(); return {}; }
  async respondApproval(approval: ApprovalRecord, decision: "accept" | "decline" | "cancel") { const pending = this.pending.get(approval.approvalId); if (!pending) throw new AgentError("APPROVAL_EPOCH_STALE", "审批已失效"); this.pending.delete(approval.approvalId); pending.resolve(decision === "accept" ? { behavior: "allow", updatedInput: pending.input } : { behavior: "deny", message: "用户拒绝执行", interrupt: decision === "cancel" }); }
  async respondInput(approval: ApprovalRecord, answers: InputAnswers) { const pending = this.pending.get(approval.approvalId); if (!pending) throw new AgentError("APPROVAL_EPOCH_STALE", "提问已失效"); this.pending.delete(approval.approvalId); const questions = Array.isArray(pending.input.questions) ? pending.input.questions.filter(isRecord) : []; const mapped = Object.fromEntries(questions.map((q, index) => [String(q.question), answers[String(index)]?.answers.join(", ") ?? ""])); pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: mapped } }); }
}
