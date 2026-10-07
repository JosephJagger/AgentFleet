import { randomUUID } from "node:crypto";
import { AgentError } from "./errors.js";
import type { CodexOperationRequest, CodexOperationResult } from "./codex-operations.js";
import type { ManagedThread, ProjectRecord } from "./types.js";
import { verifyProjectIdentity, verifySessionCwd } from "./projects.js";
import { turnPermissionPolicy } from "./permissions.js";

type Entry = { id: string; threadId: string; segment: string; project: string; state: string; output: string; exit?: number; truncated: boolean };
export class WorkspaceTerminals {
  private entries = new Map<string, Entry>();
  output(params: Record<string, unknown>) {
    const entry = this.entries.get(String(params.processId));
    if (!entry || typeof params.deltaBase64 !== "string") return;
    entry.state = "running";
    entry.output += Buffer.from(params.deltaBase64, "base64").toString("utf8");
    if (entry.output.length > 36000) { entry.output = entry.output.slice(-36000); entry.truncated = true; }
    if (params.capReached) entry.truncated = true;
  }
  async run(request: CodexOperationRequest, thread: ManagedThread, project: ProjectRecord, rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, activity?: (id: string, active: boolean) => void): Promise<CodexOperationResult> {
    if (!thread.executionSegmentId) throw new AgentError("TERMINAL_NOT_FOUND", "会话绑定已失效");
    await verifyProjectIdentity(project);
    const { operation, arguments: args } = request;
    let entry: Entry | undefined;
    if (operation === "terminal.start") {
      if ([...this.entries.values()].some(e => e.threadId === thread.nativeThreadId && ["starting", "running"].includes(e.state))) throw new AgentError("TERMINAL_BUSY", "此会话已有命令运行，请先结束原命令");
      if (this.entries.size >= 32) {
        const ended = [...this.entries.values()].find(e => !["starting", "running"].includes(e.state));
        if (ended) this.entries.delete(ended.id); else throw new AgentError("TERMINAL_BUSY", "主机终端数量已达上限");
      }
      const cwd = await verifySessionCwd(project, thread.sessionCwd ?? project.root);
      entry = { id: randomUUID(), threadId: thread.nativeThreadId, segment: thread.executionSegmentId, project: project.id, state: "starting", output: "", truncated: false };
      this.entries.set(entry.id, entry);
      const current = entry;
      activity?.(entry.id, true);
      void rpc("command/exec", { command: process.platform === "win32" ? ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", String(args.command)] : ["/bin/sh", "-c", String(args.command)], cwd, processId: entry.id, tty: true, size: { rows: 24, cols: 80 }, timeoutMs: 120000, outputBytesCap: 36000, sandboxPolicy: turnPermissionPolicy(project.root, thread.permissionProfile ?? "project") }).then(value => {
        const result = value as { exitCode?: number }; current.state = "completed"; if (typeof result.exitCode === "number") current.exit = result.exitCode;
      }).catch(() => { current.state = "failed"; current.output += "\n命令连接失败或已断开；不会自动重发。"; }).finally(() => activity?.(current.id, false));
    } else {
      entry = this.entries.get(String(args.processId));
      if (!entry || entry.threadId !== thread.nativeThreadId || entry.segment !== thread.executionSegmentId || entry.project !== project.id) throw new AgentError("TERMINAL_NOT_FOUND", "终端已结束或不属于当前会话，请重新启动");
      if (operation !== "terminal.status") {
        if (!["starting", "running"].includes(entry.state)) throw new AgentError("TERMINAL_FINISHED", "此命令已经结束");
        if (operation === "terminal.write") await rpc("command/exec/write", { processId: entry.id, deltaBase64: Buffer.from(String(args.text), "utf8").toString("base64") });
        if (operation === "terminal.stop") await rpc("command/exec/terminate", { processId: entry.id });
        if (operation === "terminal.resize") await rpc("command/exec/resize", { processId: entry.id, size: { rows: args.rows, cols: args.cols } });
      }
    }
    return { operation, status: entry.state, rows: [
      { name: "processId", detail: entry.id, status: entry.state },
      { name: "exitCode", detail: entry.exit === undefined ? "" : String(entry.exit), status: entry.truncated ? "输出已截断" : "最长运行 2 分钟" },
      ...Array.from({ length: Math.ceil(entry.output.length / 1100) }, (_, i) => ({ name: `output:${i}`, detail: entry!.output.slice(i * 1100, (i + 1) * 1100), status: "终端输出" })),
    ] };
  }
}
