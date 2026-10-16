import { voiceSignal } from "../lib/voice-signal";
import { MAX_AUTO_REDIALS, voiceStatus } from "../lib/voice-status";
import {saveReloadConnection,clearReloadConnection} from '../lib/reload-connections';
import {displayName} from '../lib/display-name';
import {DEFAULT_LIVE_WELCOME,normalizeWelcomeText,LIVE_WELCOME_INTERVAL_MS,welcomeEligible,type WelcomeBridge} from '../lib/live-interactions';
import {VoiceAudioDevices,useVoiceDevicePreferences,voiceMicrophoneConstraints} from './VoiceAudioDevices';
import type { SessionProgress } from "../lib/types";
import { useDraggablePanel } from "../lib/use-draggable-panel";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Mic, MicOff, Headset, Phone, PhoneOff, LoaderCircle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { t } from "../i18n";

export interface PanelVoiceTask { jobId:string;sessionId:string;title:string;project:string;host:string;provider?:'codex'|'claude';managed?:boolean;queuePosition?:number|null;state:string;result:string;link:string;progress?:SessionProgress;historyLimited?:boolean;executionStarted?:boolean|null;error?:{code:string;message:string}|null; }
type Phase = "idle" | "connecting" | "connected" | "recovering" | "error";
/** Audio goes directly over WebRTC. This socket carries authenticated signaling only. */
/** A connected global call that ends unexpectedly is re-dialled automatically, at most twice in a row. */
const REDIAL_DELAYS_MS = [2_000, 6_000];
/** A re-dialled call must stay up this long before it earns a fresh redial budget. */
const REDIAL_STABLE_MS = 60_000;
const UNEXPECTED_END_CODES = new Set(["SIGNAL_CLOSED", "AUDIO_DISCONNECTED", "AUDIO_FAILED", "SERVER_ERROR", "NATIVE_CLOSED"]);

export function NativeVoicePanel({ sessionId, canStart, activeTurnId, onActiveChange, globalMachineId, onPanelTask, onPanelTasks, welcomeRef, reloadRecovery=false, menuEntry=false, onConnected }: { onConnected?:()=>void; menuEntry?:boolean; reloadRecovery?:boolean; welcomeRef?:RefObject<WelcomeBridge|null>; globalMachineId?: string; onPanelTasks?: (tasks: PanelVoiceTask[]) => void; onPanelTask?: (task: PanelVoiceTask | undefined) => void; sessionId: string; canStart: boolean; activeTurnId?: string | null; onActiveChange: (active: boolean) => void }) {
  const welcomeNextAt=useRef(0);
  const welcomeSentAt=useRef(0);
  const welcomeReceipt=useRef<WelcomeBridge["receipt"]>(undefined);
  const devices=useVoiceDevicePreferences();
  const [meterStream,setMeterStream]=useState<MediaStream|null>(null);
  const [deviceError,setDeviceError]=useState('');
  const [expanded, setExpanded] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  useEffect(() => { setPortalHost(globalMachineId ? document.body : control.current?.closest(".inspector") ?? null); }, [sessionId,globalMachineId]);
  const dragging = useDraggablePanel(panel, expanded && Boolean(portalHost));
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setExpanded(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [expanded]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [taskPhase, setTaskPhase] = useState("idle");
  const [preferenceState,setPreferenceState]=useState('');
  const [skipPreferences,setSkipPreferences]=useState(false);
  const [muted, setMuted] = useState(false);
  // True while the signaling socket is down but the call (audio) is being held and reconnected.
  const [signalLost, setSignalLost] = useState(false);
  // 0 normally; 1..MAX_AUTO_REDIALS while an unexpectedly ended call is being re-dialled.
  const [redial, setRedial] = useState(0);
  const redialTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const redialCount = useRef(0);
  const redialHold = useRef(false);
  useEffect(() => { voiceStatus.publish(popoverId, { phase, muted, kind: globalMachineId ? "global" : "session", degraded: signalLost, redial }); }, [phase, muted, globalMachineId, popoverId, signalLost, redial]);
  useEffect(() => () => voiceStatus.release(popoverId), [popoverId]);
  const [transcript,setTranscript] = useState<{id?:string;role:string;text:string;done:boolean}[]>([]);
  const transcriptArea=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(transcriptArea.current) transcriptArea.current.scrollTop=transcriptArea.current.scrollHeight;},[transcript]);
  const [playBlocked, setPlayBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const outputSupported=typeof HTMLMediaElement!=='undefined'&&'setSinkId' in HTMLMediaElement.prototype;
  useEffect(()=>{let current=true;const element=audio.current as (HTMLAudioElement&{setSinkId?:(id:string)=>Promise<void>})|null;if(element?.setSinkId)void element.setSinkId(devices.speaker).then(()=>{if(current)setDeviceError('');}).catch(()=>{if(current)setDeviceError(t('扬声器切换失败，请检查权限或选择系统默认'));});return()=>{current=false;};},[devices.speaker]);
  const generation = useRef(0);
  const resources = useRef<{ connectedAt?: number; auto?: boolean; signalLost?: boolean; resumeTimer?: ReturnType<typeof setTimeout>; attempt?: WebSocket; collapsed?: boolean; recovering?: boolean; starting?: boolean; signalingReady?: boolean; stream?: MediaStream; peer?: RTCPeerConnection; socket?: WebSocket; heartbeat?: ReturnType<typeof setInterval>; disconnectTimeout?: ReturnType<typeof setTimeout>; timeout?: ReturnType<typeof setTimeout> }>({});
  const connectedCallback = useRef(onConnected);
  connectedCallback.current = onConnected;
  const activeCallback = useRef(onActiveChange);
  activeCallback.current = onActiveChange;
  const cleanup = useRef<(reason?: string) => void>(() => undefined);
  cleanup.current = (reason = "CLIENT_DISPOSED") => {
    setPreferenceState("");
    if(welcomeRef)welcomeRef.current=null;
    welcomeReceipt.current=undefined;
    welcomeNextAt.current=0;
    generation.current++;
    if (!redialHold.current) { clearTimeout(redialTimer.current); redialTimer.current = undefined; setRedial(0); }
    const owned = resources.current;
    resources.current = {};
    setMeterStream(null);
    clearInterval(owned.heartbeat); clearTimeout(owned.timeout); clearTimeout(owned.disconnectTimeout); clearTimeout(owned.resumeTimer);
    try { owned.attempt?.close(); } catch { /* already closed */ }
    setSignalLost(false);
    voiceSignal.release(popoverId);
    owned.stream?.getTracks().forEach(track => track.stop());
    owned.peer?.close();
    if (owned.socket?.readyState === WebSocket.OPEN) owned.socket.send(JSON.stringify({ type: "stop", reason }));
    owned.socket?.close();
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
    activeCallback.current(false);
  };
  useEffect(() => {
    const leavePage = () => { if (resources.current.starting || resources.current.peer || resources.current.stream) { const resume=globalMachineId&&resources.current.signalingReady?globalMachineId:undefined;cleanup.current("PAGE_LEFT");if(resume)saveReloadConnection('voice',resume);setPhase("idle"); } };
    const logout = () => { clearReloadConnection('voice');cleanup.current("USER_LOGOUT"); setPhase("idle"); };
    const otherCall = (event:Event) => {if((event as CustomEvent).detail!==popoverId&&(resources.current.starting||resources.current.peer||redialTimer.current)){cleanup.current("OTHER_CALL_STARTED");setPhase("idle");}};
    // Hidden is not destroyed: keep microphone, playback, WebRTC and signaling.
    // The server's protocol ping/pong already tolerates throttled UI timers.
    const visibility = () => {
      if (document.visibilityState !== "visible") return;
      const owned = resources.current;
      if (owned.signalingReady && owned.socket?.readyState === WebSocket.OPEN) owned.socket.send(JSON.stringify({ type: "heartbeat" }));
      const attempt = generation.current;
      if (owned.peer && audio.current?.srcObject) void audio.current.play().then(() => {
        if (generation.current === attempt) setPlayBlocked(false);
      }).catch(() => { if (generation.current === attempt) setPlayBlocked(true); });
    };
    window.addEventListener("agentfleet:voice-start",otherCall);
    window.addEventListener("agentfleet:logout",logout);
    window.addEventListener("pagehide", leavePage);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cleanup.current("CLIENT_DISPOSED");
      window.removeEventListener("agentfleet:voice-start",otherCall);
      window.removeEventListener("agentfleet:logout",logout);
      window.removeEventListener("pagehide", leavePage);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [sessionId]);

  /**
   * After an unexpected end, schedule one automatic redial if the budget allows. Returns false when the caller
   * should surface the end to the user instead. Only global calls re-dial, never after a user action.
   */
  function scheduleRedial(): boolean {
    if (!globalMachineId || redialCount.current >= MAX_AUTO_REDIALS) return false;
    const attempt = ++redialCount.current;
    setRedial(attempt); setPhase("connecting"); setMessage(""); activeCallback.current(true);
    redialTimer.current = setTimeout(() => { redialTimer.current = undefined; void start(true); }, REDIAL_DELAYS_MS[attempt - 1] ?? 6_000);
    return true;
  }
  async function start(auto = false) {
    if(globalMachineId)clearReloadConnection('voice');
    window.dispatchEvent(new CustomEvent("agentfleet:voice-start",{detail:popoverId}));
    redialHold.current = auto; // keep the "re-dialling" state while the new attempt replaces the old call
    cleanup.current();
    redialHold.current = false;
    const attempt = generation.current;
    const current = () => attempt === generation.current;
    const fail = (reason: string, code = "CLIENT_START_FAILED", final = false) => {
      if (!current()) return;
      const owned = resources.current; // read before cleanup resets it
      if (owned.connectedAt && Date.now() - owned.connectedAt >= REDIAL_STABLE_MS) redialCount.current = 0;
      // Worth re-dialling: a call that had connected and then ended for a non-user reason, or a failed re-dial attempt.
      const eligible = !final && Boolean(globalMachineId) && ((Boolean(owned.connectedAt) && UNEXPECTED_END_CODES.has(code)) || owned.auto === true);
      cleanup.current(code);
      if (eligible && scheduleRedial()) return;
      setMessage(reason); setPhase("error"); setExpanded(true);
    };
    resources.current.auto = auto;
    setExpanded(!auto); setPhase("connecting"); setMessage(""); setMuted(false); setPlayBlocked(false); setTranscript([]); setTaskPhase("idle"); onPanelTask?.(undefined); onPanelTasks?.([]);
    activeCallback.current(true);
    resources.current.starting=true;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(t("此浏览器不支持实时语音，请使用 HTTPS 下的现代浏览器"));
      const stream = await navigator.mediaDevices.getUserMedia(voiceMicrophoneConstraints(devices.microphone));
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      resources.current.stream = stream;setMeterStream(stream);
      voiceSignal.attach("mic", stream, popoverId);
      const peer = new RTCPeerConnection();
      resources.current.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      peer.createDataChannel("oai-events");
      peer.ontrack = event => {
        if (!current() || !audio.current) return;
        audio.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        voiceSignal.attach("ai", audio.current.srcObject as MediaStream, popoverId);
        void audio.current.play().catch(() => { if (current()) setPlayBlocked(true); });
      };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (peer.connectionState === "connected") { resources.current.connectedAt ??= Date.now(); setRedial(0); clearTimeout(resources.current.timeout); clearTimeout(resources.current.disconnectTimeout); resources.current.disconnectTimeout = undefined; setPhase(resources.current.recovering ? "recovering" : "connected");
          // The global coordinator tucks its windows away once per call, so one connection needs no manual closing.
          if (globalMachineId && !resources.current.recovering && !resources.current.collapsed) { resources.current.collapsed = true; setExpanded(false); connectedCallback.current?.(); } }
        // Cellular transitions can briefly disconnect ICE without ending the call.
        if (peer.connectionState === "disconnected" && !resources.current.disconnectTimeout) {
          resources.current.disconnectTimeout = setTimeout(() => fail(t("语音音频连接中断，麦克风已关闭，请重新开始"), "AUDIO_DISCONNECTED"), 8_000);
        }
        if (["failed", "closed"].includes(peer.connectionState)) fail(t("语音音频连接失败，麦克风已关闭，请更换网络后重试"), "AUDIO_FAILED");
      };
      resources.current.timeout = setTimeout(() => fail(t("语音连接超时，麦克风已关闭，请稍后重试"), "CONNECT_TIMEOUT"), 45_000);
      await peer.setLocalDescription(await peer.createOffer());
      if (!current()) return;
      await new Promise<void>(resolve => {
        if (peer.iceGatheringState === "complete") { resolve(); return; }
        const timer = setTimeout(done, 4_000);
        function done() { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", changed); resolve(); }
        function changed() { if (peer.iceGatheringState === "complete") done(); }
        peer.addEventListener("icegatheringstatechange", changed);
      });
      if (!current()) return;
      const lease = globalMachineId ? undefined : (await api.acquireLease(sessionId)).lease;
      if (!current()) return;
      const socketUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/voice`;
      const socket = new WebSocket(socketUrl);
      resources.current.socket = socket;
      let offerSent = false;let userTranscriptSeq=0;const transcriptSequences=new Map<string,number>();
      // Global calls ask the server to hold the call if the signaling socket drops (audio runs over WebRTC and is unaffected).
      let resume: { voiceId: string; token: string; graceMs: number } | undefined;
      let resumeDiag: Record<string, unknown> = {};
      let attemptSocket: WebSocket | undefined;
      let settleAttempt: ((resumed: boolean) => void) | undefined;
      let lastMessageAt = Date.now();
      const startedAt = Date.now();
      const startHeartbeat = (target: WebSocket) => {
        clearInterval(resources.current.heartbeat);
        resources.current.heartbeat = setInterval(() => {
          if (!current() || target.readyState !== WebSocket.OPEN) return;
          target.send(JSON.stringify({ type: "heartbeat" }));
        }, 15_000);
      };
      const finishResume = (target: WebSocket) => {
        resources.current.socket = target; resources.current.signalLost = false; setSignalLost(false);
        lastMessageAt = Date.now(); startHeartbeat(target);
      };
      const attemptResume = () => new Promise<boolean>(resolve => {
        const target = new WebSocket(socketUrl);
        attemptSocket = target; resources.current.attempt = target;
        const timer = setTimeout(() => settle(false), 6_000);
        function settle(resumed: boolean) {
          clearTimeout(timer); settleAttempt = undefined;
          if (!resumed) { if (attemptSocket === target) { attemptSocket = undefined; resources.current.attempt = undefined; } try { target.close(); } catch { /* already closed */ } }
          resolve(resumed);
        }
        settleAttempt = settle;
        wire(target, "resume");
      });
      const runResume = async () => {
        // Stay inside the server's hold window; retry quickly first, then back off.
        const deadline = Date.now() + Math.max(5_000, (resume?.graceMs ?? 30_000) - 6_000);
        const delays = [0, 500, 1_000, 2_000, 3_000, 4_000];
        for (let i = 0; current() && Date.now() < deadline; i++) {
          await new Promise<void>(done => { resources.current.resumeTimer = setTimeout(done, delays[Math.min(i, delays.length - 1)]); });
          if (!current()) return;
          resumeDiag = { ...resumeDiag, attempts: i + 1 };
          if (await attemptResume() || !current()) return;
        }
        if (current()) fail(t("语音连接已结束，麦克风已关闭"), "SIGNAL_CLOSED");
      };
      const signalDropped = (event?: CloseEvent) => {
        const connection = (navigator as Navigator & { connection?: { effectiveType?: string; rtt?: number; downlink?: number } }).connection;
        const usable = peer.connectionState !== "failed" && peer.connectionState !== "closed";
        if (!current() || resources.current.signalLost) return;
        if (!resume || !usable) { fail(t("语音连接已结束，麦克风已关闭"), "SIGNAL_CLOSED"); return; }
        resources.current.signalLost = true; setSignalLost(true);
        clearInterval(resources.current.heartbeat);
        // What a later look needs to tell a network drop from sleep or a throttled background tab.
        resumeDiag = { code: event?.code, wasClean: event?.wasClean, reason: event?.reason, online: navigator.onLine, visibility: document.visibilityState, net: connection?.effectiveType, rtt: connection?.rtt, downlink: connection?.downlink, lastMessageMs: Date.now() - lastMessageAt, callAgeSec: Math.round((Date.now() - startedAt) / 1000), attempts: 0 };
        void runResume();
      };
      function wire(socket: WebSocket, mode: "start" | "resume") {
        socket.onmessage = event => {
          if (!current()) return;
          lastMessageAt = Date.now();
          void (async () => {
            const value = JSON.parse(String(event.data)) as { token?:string;graceMs?:number;voiceId?:string;reason?:string;requestId?:string;utteranceId?:string;transcriptSeq?:number;snapshot?:boolean;status?:string;type?: string; sdp?: string; message?: string; role?: string; text?: string; final?: boolean; phase?: string; task?:PanelVoiceTask; tasks?:PanelVoiceTask[] };
            if (value.type === "ready" && (mode === "resume" || !offerSent)) {
              if (mode === "resume") { socket.send(JSON.stringify({ type: "panel.resume", voiceId: resume?.voiceId, resumeToken: resume?.token, diag: resumeDiag })); return; }
              offerSent = true;
              socket.send(JSON.stringify(globalMachineId ? {type:"panel.start",skipPreferences,resume:true,machineId:globalMachineId,sdp:peer.localDescription?.sdp} : { type: "start", skipPreferences, logicalSessionId: sessionId, leaseId: lease!.id, controlHeartbeat: true, sdp: peer.localDescription?.sdp }));
              resources.current.signalingReady = true;
              startHeartbeat(socket);
            } else if (globalMachineId && value.type === "resume.token" && typeof value.token === "string" && typeof value.voiceId === "string") resume = { voiceId: value.voiceId, token: value.token, graceMs: typeof value.graceMs === "number" ? value.graceMs : 30_000 };
            else if (globalMachineId && value.type === "resumed" && resume && socket === attemptSocket) {
              // The server accepted the new socket and replays what was missed after this message.
              if (typeof value.token === "string") resume.token = value.token;
              attemptSocket = undefined; resources.current.attempt = undefined;
              finishResume(socket); settleAttempt?.(true);
            } else if (value.type === "answer" && value.sdp) await peer.setRemoteDescription({ type: "answer", sdp: value.sdp });
            else if(globalMachineId && value.type==="recovering") { resources.current.recovering=true; welcomeNextAt.current=0; setPhase("recovering"); }
            else if(globalMachineId && value.type==="recovered") { resources.current.recovering=false; setPhase(peer.connectionState==="connected"?"connected":"connecting"); }
            else if(value.type==="transcript" && ["user","assistant"].includes(String(value.role)) && typeof value.text==="string") {
              if(value.utteranceId&&typeof value.transcriptSeq==='number'){if((transcriptSequences.get(value.utteranceId)??0)>=value.transcriptSeq)return;transcriptSequences.set(value.utteranceId,value.transcriptSeq);}
              if(!value.utteranceId&&value.role==='user'&&typeof value.transcriptSeq==='number'){if(value.transcriptSeq<=userTranscriptSeq)return;userTranscriptSeq=value.transcriptSeq;}
              setTranscript(previous=>{
                const last=previous.at(-1);const role=value.role!;
                const text=value.text!.slice(0,6000);
                if(value.utteranceId){const item={id:value.utteranceId,role,text,done:Boolean(value.final)};return previous.some(v=>v.id===item.id)?previous.map(v=>v.id===item.id?item:v):[...previous.slice(-5),item];}
                if(last?.role===role && !last.done) return [...previous.slice(0,-1),{role,text:value.final || value.snapshot ? text : (last.text+text).slice(-6000),done:Boolean(value.final)}];
                return [...previous.slice(-5),{role,text,done:Boolean(value.final)}];
              });
            }
            else if (!globalMachineId && value.type === "task" && ["delegated", "running", "completed", "failed"].includes(String(value.phase))) setTaskPhase(value.phase!);
            else if(value.type==='live_welcome'&&typeof value.requestId==='string'&&value.requestId===welcomeReceipt.current?.requestId){welcomeReceipt.current={requestId:value.requestId,status:value.status??'unknown',reason:value.reason};}
            else if(value.type==='report_unavailable')setMessage(t('结果播报未确认，请在待办与结果记录中查看；通话继续'));
            else if(value.type==="task_status_unavailable") setTaskPhase("unknown");
            else if(value.type==="panel_task") { const tasks=Array.isArray(value.tasks)?value.tasks:value.task?[value.task]:[]; onPanelTasks?.(tasks); onPanelTask?.(value.task); if(!value.task){setTaskPhase("idle");return;} setTaskPhase(value.task.state === "submitted" ? "delegated" : value.task.state === "interrupted" ? "failed" : value.task.state); }
            else if(value.type==="preferences")setPreferenceState(value.status??"unavailable");
            else if (value.type === "error") fail(value.message ?? t("原生实时语音暂不可用"), mode === "resume" ? "SIGNAL_CLOSED" : "SERVER_ERROR");
            else if (value.type === "closed") {
              const wasConnected = Boolean(resources.current.connectedAt);
              if (wasConnected && resources.current.connectedAt && Date.now() - resources.current.connectedAt >= REDIAL_STABLE_MS) redialCount.current = 0;
              cleanup.current("NATIVE_CLOSED");
              if (!(wasConnected && scheduleRedial())) setPhase("idle");
            }
          })().catch(() => fail(t("原生实时语音暂不可用"), "SIGNAL_INVALID"));
        };
        socket.onerror = () => { if (mode === "start" && !resume) fail(t("语音信令连接失败，麦克风已关闭，请刷新面板后重试"), "SIGNAL_FAILED"); };
        socket.onclose = event => {
          if (socket === attemptSocket) { settleAttempt?.(false); return; }
          if (socket !== resources.current.socket) return; // an old socket that a resumed one superseded
          signalDropped(event);
        };
      }
      wire(socket, "start");
    } catch (error) {
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      fail(denied ? t("请允许麦克风访问后重试") : error instanceof Error ? error.message : t("原生实时语音暂不可用"), "CLIENT_START_FAILED", denied);
    }
  }
  if(welcomeRef)welcomeRef.current={
    get receipt(){const receipt=welcomeReceipt.current;return receipt?.status==='requested'&&Date.now()-welcomeSentAt.current>10000?{...receipt,status:'unknown'}:receipt;},
    status:()=>resources.current.recovering||phase==='recovering'?'unknown':phase!=='connected'||playBlocked?'unavailable':Date.now()<welcomeNextAt.current?'busy':'ready',
    send:(event,welcomeText=DEFAULT_LIVE_WELCOME)=>{
      const text=normalizeWelcomeText(welcomeText);if(!text)return false;
      const socket=resources.current.socket;
      if(!welcomeEligible(event)||!globalMachineId||welcomeRef.current?.status()!=='ready'||socket?.readyState!==WebSocket.OPEN)return false;
      const requestId=crypto.randomUUID();
      welcomeReceipt.current={requestId,status:'requested'};welcomeSentAt.current=Date.now();
      socket.send(JSON.stringify({type:'live.welcome',welcomeText:text,viewerDisplayName:displayName(event.name),kind:'enter',source:'home-douyin-collector:companion-log',streamEnabled:true,nativeMethod:'WebcastMemberMessage',entryAction:'1',sourceObservedAt:event.sourceObservedAt,nativeInterruptible:true,requestId,eventId:event.id,roomId:event.roomId,ownerId:event.ownerId,viewerId:event.userId,observedAt:event.receivedAt}));
      welcomeNextAt.current=Date.now()+LIVE_WELCOME_INTERVAL_MS;
      return true;
    },
  };
  const active = phase === "connecting" || phase === "connected" || phase === "recovering";
  const status = redial > 0 ? t("通话意外中断，正在自动重拨（{0}/{1}）…", redial, MAX_AUTO_REDIALS) : signalLost ? t("网络波动，正在自动重连信令（通话音频保持）…") : active ? t(phase === "recovering" ? "正在恢复主机连接，核验原通话中（最多 60 秒）" : phase === "connecting" ? "正在连接麦克风与 Codex…" : muted ? "麦克风已静音" : "语音已连接，直接与 Codex 对话") : t("实验功能 · 使用主机的 Codex 登录账号");
  // Refreshing or closing the page ends the call, so ask before an accidental reload or close (no text is customisable in browsers).
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
  const callPanel = expanded && <div ref={panel} style={dragging.style} id={popoverId} className={`native-voice__popover${globalMachineId ? " native-voice__popover--global" : ""}`} role="region" aria-label={t("原生实时语音")}>
    <div className="native-voice__head voice-drag-handle" {...dragging.handle}><strong>{t(globalMachineId ? "面板语音总控" : "语音通话")}</strong><button type="button" className="native-voice__close" aria-label={t("收起语音控制")} onClick={() => { setExpanded(false); trigger.current?.focus(); }}><X size={16} /></button></div>
    <div className={`native-voice__orb${active && !muted ? " native-voice__orb--live" : ""}`} aria-hidden="true">{(phase === "connecting" || phase === "recovering") && <LoaderCircle className="spin" size={24} />}</div>
    <p className="native-voice__status" role="status">{status}</p>
    {!active&&<label className="native-voice__status"><input type="checkbox" checked={skipPreferences} onChange={e=>setSkipPreferences(e.target.checked)}/>{t('本次通话不加载长期偏好')}</label>}
    {active&&preferenceState&&<p className="native-voice__status" role="status">{t(preferenceState==='disabled'?'本次通话不加载长期偏好':preferenceState==='loaded'?'长期偏好已加载':preferenceState==='reconnect_required'?'偏好已更新，请挂断重连以清除旧规则上下文':preferenceState==='pending'?'长期偏好同步中':'长期偏好暂未加载；通话仍保持连接')}</p>}
    <details className="native-voice__device-settings"><summary>{t('音频设备与检测')}</summary><VoiceAudioDevices active={active} stream={meterStream} microphone={devices.microphone} speaker={devices.speaker} onMicrophone={devices.setMicrophone} onSpeaker={devices.setSpeaker} outputSupported={outputSupported}/>{deviceError&&<p role="status">{deviceError}</p>}</details>
    {!active&&<button type="button" className="button button--primary" disabled={!canStart} onClick={()=>void start()}>{t(reloadRecovery?'恢复语音':'开始通话')}</button>}
    {message && <p className="native-voice__error" role="alert">{message}</p>}
    {active && <p className="native-voice__task" role="status">{t(activeTurnId || taskPhase === "running" ? "项目任务正在执行" : taskPhase === "delegated" ? "已派发，等待项目任务启动" : taskPhase === "completed" ? "项目任务已完成，结果见会话" : taskPhase === "failed" ? "项目任务未完成，请查看会话结果" : taskPhase === "unknown" ? "任务状态暂不可用，通话可继续" : "尚未派发项目任务")}</p>}
    {active && <div className="native-voice__actions">
      <button type="button" className="button button--secondary" disabled={phase !== "connected" && phase !== "recovering"} aria-pressed={muted} onClick={() => { const next = !muted; resources.current.stream?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next); }}>{muted ? <MicOff size={18} /> : <Mic size={18} />}{t(muted ? "取消静音" : "静音")}</button>
      <button type="button" className="button button--stop" onClick={() => { cleanup.current("USER_HANGUP"); setPhase("idle"); setExpanded(false); }}><PhoneOff size={18} />{t("挂断")}</button>
    </div>}
    {playBlocked && active && <button type="button" className="button button--secondary" onClick={() => { void audio.current?.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true)); }}>{t("播放 Codex 语音")}</button>}
    {transcript.length > 0 && <details className="native-voice__transcript-details"><summary>{t("本次语音转写")}</summary><div className="native-voice__transcript" ref={transcriptArea} tabIndex={0}>{transcript.map((entry,index) => <p key={index}><strong>{entry.role === "user" ? t("你") : "Codex"}</strong><span>{entry.text}</span></p>)}</div></details>}
  </div>;
  return <div ref={control} className={`native-voice${globalMachineId ? " native-voice--panel" : ""}${active ? " native-voice--active" : ""}`}>
    <button ref={trigger} type="button" className={`button ${globalMachineId ? "button--primary" : "button--secondary"} native-voice__trigger${menuEntry ? " native-voice__trigger--menu" : ""}`} disabled={!active && !canStart} aria-label={t(globalMachineId ? active ? "总控通话控制" : reloadRecovery ? "恢复语音" : "开始总控通话" : active ? "语音控制" : "开始语音")} title={t(globalMachineId ? active ? "总控通话控制" : reloadRecovery ? "恢复语音" : "开始总控通话" : active ? "语音控制" : "开始语音")} aria-expanded={expanded} aria-controls={expanded ? popoverId : undefined} onClick={() => { if (active) setExpanded(value => !value); else void start(); }}>
      {phase === "connecting" || phase === "recovering" ? <LoaderCircle className="spin" size={19} /> : globalMachineId ? <Headset size={20} /> : <Phone size={19} />}
      {menuEntry && !globalMachineId && <span>{t(active ? "语音控制" : "开始语音")}</span>}
      {globalMachineId && <span>{t(phase === "recovering" ? "恢复中…" : phase === "connecting" ? "正在连接…" : active ? "通话控制" : reloadRecovery ? "恢复语音" : "开始通话")}</span>}
      {active && <i className="native-voice__indicator" aria-hidden="true" />}
    </button>
    {portalHost ? createPortal(callPanel, portalHost) : callPanel}
    <audio ref={audio} autoPlay />
  </div>;
}
