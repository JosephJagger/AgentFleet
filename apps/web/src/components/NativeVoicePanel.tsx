import { useEffect, useId, useRef, useState } from "react";
import { Mic, MicOff, Headset, Phone, PhoneOff, LoaderCircle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { t } from "../i18n";

export interface PanelVoiceTask { jobId:string;sessionId:string;title:string;project:string;host:string;state:string;result:string;link:string; }
type Phase = "idle" | "connecting" | "connected" | "error";
/** Audio goes directly over WebRTC. This socket carries authenticated signaling only. */
export function NativeVoicePanel({ sessionId, canStart, activeTurnId, onActiveChange, globalMachineId, onPanelTask }: { globalMachineId?: string; onPanelTask?: (task: PanelVoiceTask) => void; sessionId: string; canStart: boolean; activeTurnId?: string | null; onActiveChange: (active: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = useState<Element | null>(null);
  useEffect(() => { setPortalHost(globalMachineId ? document.body : control.current?.closest(".inspector") ?? null); }, [sessionId,globalMachineId]);
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
  const [muted, setMuted] = useState(false);
  const [transcript,setTranscript] = useState<{role:string;text:string;done:boolean}[]>([]);
  const transcriptArea=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(transcriptArea.current) transcriptArea.current.scrollTop=transcriptArea.current.scrollHeight;},[transcript]);
  const [playBlocked, setPlayBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const resources = useRef<{ starting?: boolean; stream?: MediaStream; peer?: RTCPeerConnection; socket?: WebSocket; heartbeat?: ReturnType<typeof setInterval>; disconnectTimeout?: ReturnType<typeof setTimeout>; timeout?: ReturnType<typeof setTimeout> }>({});
  const activeCallback = useRef(onActiveChange);
  activeCallback.current = onActiveChange;
  const cleanup = useRef<(reason?: string) => void>(() => undefined);
  cleanup.current = (reason = "CLIENT_DISPOSED") => {
    generation.current++;
    const owned = resources.current;
    resources.current = {};
    clearInterval(owned.heartbeat); clearTimeout(owned.timeout); clearTimeout(owned.disconnectTimeout);
    owned.stream?.getTracks().forEach(track => track.stop());
    owned.peer?.close();
    if (owned.socket?.readyState === WebSocket.OPEN) owned.socket.send(JSON.stringify({ type: "stop", reason }));
    owned.socket?.close();
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
    activeCallback.current(false);
  };
  useEffect(() => {
    const hide = () => { if (resources.current.starting || resources.current.peer || resources.current.stream) { cleanup.current("PAGE_HIDDEN"); setPhase("idle"); } };
    const otherCall = (event:Event) => {if((event as CustomEvent).detail!==popoverId&&(resources.current.starting||resources.current.peer)){cleanup.current("USER_HANGUP");setPhase("idle");}};
    window.addEventListener("agentfleet:voice-start",otherCall);
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => { cleanup.current(); window.removeEventListener("agentfleet:voice-start",otherCall); window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); };
  }, [sessionId]);

  async function start() {
    window.dispatchEvent(new CustomEvent("agentfleet:voice-start",{detail:popoverId}));
    cleanup.current();
    const attempt = generation.current;
    const current = () => attempt === generation.current;
    const fail = (reason: string, code = "CLIENT_START_FAILED") => { if (current()) { cleanup.current(code); setMessage(reason); setPhase("error"); setExpanded(true); } };
    setExpanded(true); setPhase("connecting"); setMessage(""); setMuted(false); setPlayBlocked(false); setTranscript([]); setTaskPhase("idle");
    activeCallback.current(true);
    resources.current.starting=true;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(t("此浏览器不支持实时语音，请使用 HTTPS 下的现代浏览器"));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      resources.current.stream = stream;
      const peer = new RTCPeerConnection();
      resources.current.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      peer.createDataChannel("oai-events");
      peer.ontrack = event => {
        if (!current() || !audio.current) return;
        audio.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.current.play().catch(() => { if (current()) setPlayBlocked(true); });
      };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (peer.connectionState === "connected") { clearTimeout(resources.current.timeout); clearTimeout(resources.current.disconnectTimeout); resources.current.disconnectTimeout = undefined; setPhase("connected"); }
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
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/voice`);
      resources.current.socket = socket;
      let offerSent = false;
      socket.onmessage = event => {
        if (!current()) return;
        void (async () => {
          const value = JSON.parse(String(event.data)) as { type?: string; sdp?: string; message?: string; role?: string; text?: string; final?: boolean; phase?: string; task?:PanelVoiceTask };
          if (value.type === "ready" && !offerSent) {
            offerSent = true;
            socket.send(JSON.stringify(globalMachineId ? {type:"panel.start",machineId:globalMachineId,sdp:peer.localDescription?.sdp} : { type: "start", logicalSessionId: sessionId, leaseId: lease!.id, controlHeartbeat: true, sdp: peer.localDescription?.sdp }));
            resources.current.heartbeat = setInterval(() => {
              if (!current() || socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({ type: "heartbeat" }));
            }, 15_000);
          } else if (value.type === "answer" && value.sdp) await peer.setRemoteDescription({ type: "answer", sdp: value.sdp });
          else if(value.type==="transcript" && ["user","assistant"].includes(String(value.role)) && typeof value.text==="string") {
            setTranscript(previous=>{
              const last=previous.at(-1);const role=value.role!;
              const text=value.text!.slice(0,6000);
              if(last?.role===role && !last.done) return [...previous.slice(0,-1),{role,text:value.final ? text : (last.text+text).slice(-6000),done:Boolean(value.final)}];
              return [...previous.slice(-5),{role,text,done:Boolean(value.final)}];
            });
          }
          else if (value.type === "task" && ["delegated", "running", "completed", "failed"].includes(String(value.phase))) setTaskPhase(value.phase!);
          else if(value.type==="task_status_unavailable") setTaskPhase("unknown");
          else if(value.type==="panel_task" && value.task) { onPanelTask?.(value.task); setTaskPhase(value.task.state === "submitted" ? "delegated" : value.task.state === "interrupted" ? "failed" : value.task.state); }
          else if (value.type === "error") fail(value.message ?? t("原生实时语音暂不可用"), "SERVER_ERROR");
          else if (value.type === "closed") { cleanup.current("NATIVE_CLOSED"); setPhase("idle"); }
        })().catch(() => fail(t("原生实时语音暂不可用"), "SIGNAL_INVALID"));
      };
      socket.onerror = () => fail(t("语音信令连接失败，麦克风已关闭，请刷新面板后重试"), "SIGNAL_FAILED");
      socket.onclose = () => fail(t("语音连接已结束，麦克风已关闭"), "SIGNAL_CLOSED");
    } catch (error) {
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      fail(denied ? t("请允许麦克风访问后重试") : error instanceof Error ? error.message : t("原生实时语音暂不可用"));
    }
  }
  const active = phase === "connecting" || phase === "connected";
  const status = active ? t(phase === "connecting" ? "正在连接麦克风与 Codex…" : muted ? "麦克风已静音" : "语音已连接，直接与 Codex 对话") : t("实验功能 · 使用主机的 Codex 登录账号");
  const callPanel = expanded && <div ref={panel} id={popoverId} className={`native-voice__popover${globalMachineId ? " native-voice__popover--global" : ""}`} role="region" aria-label={t("原生实时语音")}>
    <div className="native-voice__head"><strong>{t(globalMachineId ? "面板语音总控" : "语音通话")}</strong><button type="button" className="native-voice__close" aria-label={t("收起语音控制")} onClick={() => { setExpanded(false); trigger.current?.focus(); }}><X size={16} /></button></div>
    <div className={`native-voice__orb${active && !muted ? " native-voice__orb--live" : ""}`} aria-hidden="true">{phase === "connecting" && <LoaderCircle className="spin" size={24} />}</div>
    <p className="native-voice__status" role="status">{status}</p>
    {message && <p className="native-voice__error" role="alert">{message}</p>}
    {active && <p className="native-voice__task" role="status">{t(activeTurnId || taskPhase === "running" ? "项目任务正在执行" : taskPhase === "delegated" ? "已派发，等待项目任务启动" : taskPhase === "completed" ? "项目任务已完成，结果见会话" : taskPhase === "failed" ? "项目任务未完成，请查看会话结果" : taskPhase === "unknown" ? "任务状态暂不可用，通话可继续" : "尚未派发项目任务")}</p>}
    {active && <div className="native-voice__actions">
      <button type="button" className="button button--secondary" disabled={phase !== "connected"} aria-pressed={muted} onClick={() => { const next = !muted; resources.current.stream?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next); }}>{muted ? <MicOff size={18} /> : <Mic size={18} />}{t(muted ? "取消静音" : "静音")}</button>
      <button type="button" className="button button--stop" onClick={() => { cleanup.current("USER_HANGUP"); setPhase("idle"); setExpanded(false); }}><PhoneOff size={18} />{t("挂断")}</button>
    </div>}
    {playBlocked && active && <button type="button" className="button button--secondary" onClick={() => { void audio.current?.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true)); }}>{t("播放 Codex 语音")}</button>}
    {transcript.length > 0 && <details className="native-voice__transcript-details"><summary>{t("本次语音转写")}</summary><div className="native-voice__transcript" ref={transcriptArea} tabIndex={0}>{transcript.map((entry,index) => <p key={index}><strong>{entry.role === "user" ? t("你") : "Codex"}</strong><span>{entry.text}</span></p>)}</div></details>}
  </div>;
  return <div ref={control} className={`native-voice${globalMachineId ? " native-voice--panel" : ""}${active ? " native-voice--active" : ""}`}>
    <button ref={trigger} type="button" className={`button ${globalMachineId ? "button--primary" : "button--secondary"} native-voice__trigger`} disabled={!active && !canStart} aria-label={t(globalMachineId ? active ? "总控通话控制" : "开始总控通话" : active ? "语音控制" : "开始语音")} title={t(globalMachineId ? active ? "总控通话控制" : "开始总控通话" : active ? "语音控制" : "开始语音")} aria-expanded={expanded} aria-controls={expanded ? popoverId : undefined} onClick={() => { if (active) setExpanded(value => !value); else void start(); }}>
      {phase === "connecting" ? <LoaderCircle className="spin" size={19} /> : globalMachineId ? <Headset size={20} /> : <Phone size={19} />}
      {globalMachineId && <span>{t(phase === "connecting" ? "正在连接…" : active ? "通话控制" : "开始通话")}</span>}
      {active && <i className="native-voice__indicator" aria-hidden="true" />}
    </button>
    {portalHost ? createPortal(callPanel, portalHost) : callPanel}
    <audio ref={audio} autoPlay />
  </div>;
}
