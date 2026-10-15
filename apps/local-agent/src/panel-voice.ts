import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServer, type AppServerCallbacks } from "./app-server.js";
import { voiceErrorCode } from "./voice-errors.js";
import { AgentError } from "./errors.js";
import type { StateStore } from "./store.js";

type PanelClient = Pick<CodexAppServer, 'start'|'stop'|'getProcessId'|'startPanelVoice'|'reportPanelVoice'|'stopVoice'|'updateVoicePreferences'>;
interface Call { instanceId: string; pid?: number; suspendedUntil?: number; id: string; client: PanelClient; threadId?: string; directory?: string; lastSeen: number; cancelled: boolean; ready: Promise<void>; transcriptSeq?: number; transcripts: Map<string, Transcript>; activeTranscripts: Map<string,string>; }

interface Transcript {utteranceId:string;role:string;text:string;final:boolean;transcriptSeq:number;utteranceSeq:number;observedAt:string;}

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
      if (this.current && (Date.now() - this.current.lastSeen > 120000 || this.current.suspendedUntil !== undefined && Date.now() >= this.current.suspendedUntil)) void this.stop().catch(() => undefined);
    }, 5000);
    this.watchdog.unref();
  }

  async start(id: string, sdp: string, voice?: string, preferences?:string) {
    if (this.current || this.stopping || this.store.snapshot().panelVoiceRuntime) throw new AgentError('VOICE_BUSY', 'Panel voice is active or awaiting cleanup');
    const client = this.factory({
      findManagedThread: () => undefined, findProject: () => undefined, onEvent: async () => undefined,
      onVolatile: event => {
        if (event.type !== 'voice.event' || this.current?.id !== id || this.current.cancelled) return;
        const call=this.current;
        if(event.payload.event==='transcript'&&['user','assistant'].includes(String(event.payload.role))&&typeof event.payload.text==='string'){
          const role=String(event.payload.role);
          const nativeId=typeof event.payload.utteranceId==='string'?event.payload.utteranceId:undefined;
          const id=nativeId??call.activeTranscripts.get(role)??randomUUID();
          const previous=call.transcripts.get(id);
          const item:Transcript={utteranceId:id,utteranceSeq:previous?.utteranceSeq??(call.transcriptSeq??0)+1,role,text:event.payload.final?event.payload.text:(previous?.text??'')+event.payload.text,final:Boolean(event.payload.final),transcriptSeq:(call.transcriptSeq??0)+1,observedAt:previous?.observedAt??new Date().toISOString()};
          call.transcriptSeq=item.transcriptSeq;call.transcripts.set(id,item);
          if(item.final)call.activeTranscripts.delete(role);else call.activeTranscripts.set(role,id);
          this.emit({type:'voice.event',voiceId:call.id,event:'transcript',...item,transcriptSnapshot:true,instanceId:call.instanceId});
        }else this.emit({ type: 'voice.event', voiceId: id, ...event.payload, resumeAck:true, instanceId: call.instanceId });
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
        if (this.current.suspendedUntil !== undefined) return { error: 'Voice control is recovering; no task was dispatched. Query status after recovery before retrying.' };
        const requestId = randomUUID();
        return new Promise(resolve => {
          const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ error: 'Result unknown; query status before retrying dispatch.' }); }, typeof args==='object'&&args!==null&&'action' in args&&args.action==='recover'&&!this.current?.threadId?5000:30000);
          this.pending.set(requestId, { resolve, timer });
          this.emit({ type: 'voice.event', voiceId: id, event: 'panel_tool', requestId, args });
        });
      },
    });
    const call: Call = { instanceId: randomUUID(), id, client, lastSeen: Date.now(), cancelled: false, transcripts:new Map(), activeTranscripts:new Map(), ready: Promise.resolve() };
    this.current = call;
    call.ready = (async () => {
      call.directory = await mkdtemp(join(tmpdir(), 'agentfleet-panel-voice-'));
      await this.store.setPanelVoiceRuntime({ voiceId: id });
      if (call.cancelled) return;
      await client.start();
      const pid=client.getProcessId();if(pid)call.pid=pid;
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

  /** Retain this exact native call for a bounded transport interruption. Never start a replacement. */
  suspend() {
    const call = this.current;
    if (!call || call.cancelled || call.suspendedUntil !== undefined) return;
    call.suspendedUntil = Date.now() + 60000;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ error: 'Connection changed; dispatch outcome may be unknown. Query task status after recovery; do not repeat dispatch.' });
    }
    this.pending.clear();
  }
  probe(id: string, requestId: string) {
    const call = this.current;
    const live = call?.id === id && !call.cancelled && !!call.threadId && !!call.pid && call.pid === call.client.getProcessId();
    this.emit({type:'voice.event',voiceId:id,event:'recovery',requestId,
      recoveryState:live?'present':this.store.snapshot().panelVoiceRuntime?.voiceId === id?'unknown':'absent',
      ...(live?{instanceId:call!.instanceId}: {})});
  }
  resume(id: string, instanceId: unknown, requestId?:string) {
    const call = this.current;
    if (!call || call.id !== id || call.instanceId !== instanceId || call.cancelled || !call.threadId || (!call.pid || call.pid !== call.client.getProcessId())
      || call.suspendedUntil !== undefined && Date.now() >= call.suspendedUntil)
      throw new AgentError('VOICE_FENCED', 'Original voice process is no longer resumable');
    delete call.suspendedUntil;
    call.lastSeen = Date.now();
    if(requestId)this.emit({type:'voice.event',voiceId:id,event:'resumed',instanceId:call.instanceId,requestId});
    for(const item of [...call.transcripts.values()].sort((a,b)=>a.utteranceSeq-b.utteranceSeq))this.emit({type:'voice.event',voiceId:id,event:'transcript',...item,transcriptSnapshot:true,transcriptReplay:true,instanceId:call.instanceId});
  }
  acknowledgeTranscript(id:string,utteranceId:unknown,sequence:unknown){
    const call=this.current;if(!call||call.id!==id||typeof utteranceId!=='string')return;
    const item=call.transcripts.get(utteranceId);
    if(item?.final&&item.transcriptSeq===sequence)call.transcripts.delete(utteranceId);
  }
  heartbeat(id: string) { if (this.current?.id === id) this.current.lastSeen = Date.now(); }
  result(id: string, requestId: string, result: unknown) {
    if (this.current?.id !== id || this.current.cancelled) return;
    const pending = this.pending.get(requestId);
    if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve(result); }
  }
  async report(id: string, text: string, reportId: string) {
    const call = this.current;
    if (!call || call.id !== id || call.cancelled || call.suspendedUntil!==undefined || !call.threadId) throw new AgentError('VOICE_FENCED', 'Call ended');
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
