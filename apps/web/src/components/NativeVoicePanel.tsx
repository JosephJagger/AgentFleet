import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio } from "lucide-react";
import { api } from "../lib/api";
import { t } from "../i18n";

type Phase = "idle" | "connecting" | "connected" | "error";
/** Audio goes directly over WebRTC. This socket carries authenticated signaling only. */
export function NativeVoicePanel({ sessionId, canStart, onActiveChange }: { sessionId: string; canStart: boolean; onActiveChange: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [muted, setMuted] = useState(false);
  const [transcript,setTranscript] = useState<{role:string;text:string;done:boolean}[]>([]);
  const transcriptArea=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(transcriptArea.current) transcriptArea.current.scrollTop=transcriptArea.current.scrollHeight;},[transcript]);
  const [playBlocked, setPlayBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const resources = useRef<{ starting?: boolean; stream?: MediaStream; peer?: RTCPeerConnection; socket?: WebSocket; heartbeat?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }>({});
  const activeCallback = useRef(onActiveChange);
  activeCallback.current = onActiveChange;
  const cleanup = useRef<() => void>(() => undefined);
  cleanup.current = () => {
    generation.current++;
    const owned = resources.current;
    resources.current = {};
    clearInterval(owned.heartbeat); clearTimeout(owned.timeout);
    owned.stream?.getTracks().forEach(track => track.stop());
    owned.peer?.close();
    if (owned.socket?.readyState === WebSocket.OPEN) owned.socket.send(JSON.stringify({ type: "stop" }));
    owned.socket?.close();
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
    activeCallback.current(false);
  };
  useEffect(() => {
    const hide = () => { if (resources.current.starting || resources.current.peer || resources.current.stream) { cleanup.current(); setPhase("idle"); } };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => { cleanup.current(); window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); };
  }, [sessionId]);

  async function start() {
    cleanup.current();
    const attempt = generation.current;
    const current = () => attempt === generation.current;
    const fail = (reason: string) => { if (current()) { cleanup.current(); setMessage(reason); setPhase("error"); } };
    setPhase("connecting"); setMessage(""); setMuted(false); setPlayBlocked(false); setTranscript([]);
    activeCallback.current(true);
    resources.current.starting=true;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error(t("此浏览器不支持实时语音，请使用 HTTPS 下的现代浏览器"));
      let { lease } = await api.acquireLease(sessionId);
      if (!current()) return;
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
        if (peer.connectionState === "connected") { clearTimeout(resources.current.timeout); setPhase("connected"); }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) fail(t("语音连接中断，麦克风已关闭，请重新开始"));
      };
      resources.current.timeout = setTimeout(() => fail(t("语音连接超时，麦克风已关闭，请稍后重试")), 45_000);
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
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/voice`);
      resources.current.socket = socket;
      let offerSent = false;
      socket.onmessage = event => {
        if (!current()) return;
        void (async () => {
          const value = JSON.parse(String(event.data)) as { type?: string; sdp?: string; message?: string; role?: string; text?: string; final?: boolean };
          if (value.type === "ready" && !offerSent) {
            offerSent = true;
            socket.send(JSON.stringify({ type: "start", logicalSessionId: sessionId, leaseId: lease.id, sdp: peer.localDescription?.sdp }));
            let renewing = false;
            resources.current.heartbeat = setInterval(() => {
              if (!current() || socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({ type: "heartbeat" }));
              if (!renewing) {
                renewing = true;
                void api.renewLease(sessionId, lease.id, lease.version).then(result => { lease = result.lease; }).catch(() => fail(t("会话控制权已失效，麦克风已关闭"))).finally(() => { renewing = false; });
              }
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
          else if (value.type === "error") fail(value.message ?? t("原生实时语音暂不可用"));
          else if (value.type === "closed") { cleanup.current(); setPhase("idle"); }
        })().catch(() => fail(t("原生实时语音暂不可用")));
      };
      socket.onerror = () => fail(t("语音连接中断，麦克风已关闭，请重新开始"));
      socket.onclose = () => fail(t("语音连接已结束，麦克风已关闭"));
    } catch (error) {
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      fail(denied ? t("请允许麦克风访问后重试") : error instanceof Error ? error.message : t("原生实时语音暂不可用"));
    }
  }
  const active = phase === "connecting" || phase === "connected";
  return <section className="native-voice" aria-label={t("原生实时语音")}>
    <div className="native-voice__description"><Radio size={18} /><span><strong>{t("原生实时语音")}</strong><small>{active ? t(phase === "connecting" ? "正在连接麦克风与 Codex…" : muted ? "麦克风已静音" : "语音已连接，直接与 Codex 对话") : t("实验功能 · 使用主机的 Codex 登录账号")}</small></span></div>
    <div className="native-voice__actions">{active ? <>
      <button type="button" className="button button--secondary" disabled={phase !== "connected"} aria-pressed={muted} onClick={() => { const next = !muted; resources.current.stream?.getAudioTracks().forEach(track => { track.enabled = !next; }); setMuted(next); }}>{muted ? <MicOff size={16} /> : <Mic size={16} />}{t(muted ? "取消静音" : "静音")}</button>
      <button type="button" className="button button--stop" onClick={() => { cleanup.current(); setPhase("idle"); }}><PhoneOff size={16} />{t("结束语音")}</button>
    </> : <button type="button" className="button button--secondary" disabled={!canStart} onClick={() => void start()}><Mic size={16} />{t("开始语音")}</button>}</div>
    {message && <p className="native-voice__error" role="alert">{message}</p>}
    {playBlocked && active && <button type="button" className="button button--secondary" onClick={() => { void audio.current?.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true)); }}>{t("播放 Codex 语音")}</button>}
    <p className="native-voice__hint">{t("语音可以触发开发任务，沿用会话权限与审批；结束语音不会取消已开始的任务。")}</p>
    {transcript.length>0 && <div className="native-voice__transcript" ref={transcriptArea} aria-label={t("本次语音转写")} tabIndex={0}>{transcript.map((entry,index)=><p key={index}><strong>{entry.role==="user" ? t("你") : "Codex"}</strong><span>{entry.text}</span></p>)}</div>}
    <audio ref={audio} autoPlay />
  </section>;
}
