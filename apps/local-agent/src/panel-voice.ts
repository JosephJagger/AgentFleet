import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServer, type AppServerCallbacks } from "./app-server.js";
import { voiceErrorCode } from "./voice-errors.js";
import { AgentError } from "./errors.js";
import type { StateStore } from "./store.js";

type PanelClient = Pick<CodexAppServer, 'start'|'stop'|'getProcessId'|'startPanelVoice'|'reportPanelVoice'|'stopVoice'|'updateVoicePreferences'>;
interface Call { id: string; client: PanelClient; threadId?: string; directory?: string; lastSeen: number; cancelled: boolean; ready: Promise<void>; }

/** A dedicated ephemeral native writer, separate from all project sessions. */
export class PanelVoiceRuntime {
  private current: Call | undefined;
  private stopping: Promise<void> | undefined;
  private reports = new Map<string, Promise<void>>();
  private pending = new Map<string, { resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private watchdog: ReturnType<typeof setInterval>;

  constructor(private store: StateStore, private emit: (event: Record<string, unknown>) => void,
    private factory: (callbacks: AppServerCallbacks) => PanelClient = callbacks => new CodexAppServer(callbacks)) {
    this.watchdog = setInterval(() => {
      if (this.current && Date.now() - this.current.lastSeen > 120000) void this.stop().catch(() => undefined);
    }, 5000);
    this.watchdog.unref();
  }

  async start(id: string, sdp: string, voice?: string, preferences?:string) {
    if (this.current || this.stopping || this.store.snapshot().panelVoiceRuntime) throw new AgentError('VOICE_BUSY', 'Panel voice is active or awaiting cleanup');
    const client = this.factory({
      findManagedThread: () => undefined, findProject: () => undefined, onEvent: async () => undefined,
      onVolatile: event => {
        if (event.type !== 'voice.event' || this.current?.id !== id || this.current.cancelled) return;
        this.emit({ type: 'voice.event', voiceId: id, ...event.payload });
        // Native audio closure does not dispose the dedicated app-server process.
        // Do not await here: stopVoice drains the notification currently being handled.
        if (event.payload.event === 'closed' || event.payload.event === 'error')
          queueMicrotask(() => { void this.stop(id).catch(() => undefined); });
      },
      onApproval: async () => { throw new AgentError('PANEL_TOOL_DENIED', 'Use the panel dispatch tool'); },
      onApprovalResolved: async () => undefined,
      // Do not await stop from the process exit callback: stop itself waits for process exit.
      onExit: async () => { if (this.current?.id === id) void this.stop(id).catch(() => undefined); },
      onPanelTool: async args => {
        if (this.current?.id !== id || this.current.cancelled) throw new AgentError('VOICE_FENCED', 'Call ended');
        const requestId = randomUUID();
        return new Promise(resolve => {
          const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ error: 'Result unknown; query status before retrying dispatch.' }); }, typeof args==='object'&&args!==null&&'action' in args&&args.action==='recover'&&!this.current?.threadId?5000:30000);
          this.pending.set(requestId, { resolve, timer });
          this.emit({ type: 'voice.event', voiceId: id, event: 'panel_tool', requestId, args });
        });
      },
    });
    const call: Call = { id, client, lastSeen: Date.now(), cancelled: false, ready: Promise.resolve() };
    this.current = call;
    call.ready = (async () => {
      call.directory = await mkdtemp(join(tmpdir(), 'agentfleet-panel-voice-'));
      await this.store.setPanelVoiceRuntime({ voiceId: id });
      if (call.cancelled) return;
      await client.start();
      await this.store.setPanelVoiceRuntime({ voiceId: id, ...(client.getProcessId() ? { pid: client.getProcessId()! } : {}) });
      if (call.cancelled) return;
      call.threadId = await client.startPanelVoice(call.directory, id, sdp, voice, preferences);
    })();
    try { await call.ready; } catch (error) {
      // Deliver the sanitized cause before stopped, which releases the browser owner.
      this.emit({type:'voice.event',voiceId:id,event:'error',message:voiceErrorCode(error instanceof Error?error.message:'')});
      await this.stop(id); throw error;
    }
  }

  heartbeat(id: string) { if (this.current?.id === id) this.current.lastSeen = Date.now(); }
  result(id: string, requestId: string, result: unknown) {
    if (this.current?.id !== id || this.current.cancelled) return;
    const pending = this.pending.get(requestId);
    if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve(result); }
  }
  async report(id: string, text: string, reportId: string) {
    const call = this.current;
    if (!call || call.id !== id || call.cancelled || !call.threadId) throw new AgentError('VOICE_FENCED', 'Call ended');
    let sent = this.reports.get(reportId);
    if (!sent) { sent = call.client.reportPanelVoice(call.threadId, text); this.reports.set(reportId, sent); }
    await sent;
    this.emit({type:"voice.event",voiceId:id,event:"reported",requestId:reportId});
  }
  async preferences(id:string,text:string,requestId:string) {
    const call=this.current;if(!call||call.id!==id||call.cancelled)throw new AgentError('VOICE_FENCED','Call ended');
    await call.ready;
    if(!call.threadId||call.cancelled)throw new AgentError('VOICE_FENCED','Call ended');
    await call.client.updateVoicePreferences(call.threadId,text,requestId);
    this.emit({type:'voice.event',voiceId:id,event:'reported',requestId});
  }
  stop(id?: string): Promise<void> {
    const call = this.current;
    if (!call || (id && call.id !== id)) {
      // A rejected start never owned a writer. Acknowledge its stop without
      // stopping another call; persisted unknown ownership must stay fenced.
      if (id && this.store.snapshot().panelVoiceRuntime?.voiceId !== id)
        this.emit({ type: 'voice.event', voiceId: id, event: 'stopped' });
      return Promise.resolve();
    }
    if (this.stopping) return this.stopping;
    call.cancelled = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.resolve({ error: 'Call ended; dispatched target tasks continue.' });
    }
    this.pending.clear();
    this.reports.clear();
    this.stopping = (async () => {
      await call.ready.catch(() => undefined);
      try { if (call.threadId) await call.client.stopVoice(call.threadId); }
      finally {
        await call.client.stop();
        await this.store.setPanelVoiceRuntime(undefined);
        if (call.directory) await rm(call.directory, { recursive: true, force: true });
        this.emit({ type: 'voice.event', voiceId: call.id, event: 'stopped' });
      }
    })().finally(() => { this.current = undefined; this.stopping = undefined; });
    return this.stopping;
  }
  async close() { clearInterval(this.watchdog); await this.stop(); }
}
