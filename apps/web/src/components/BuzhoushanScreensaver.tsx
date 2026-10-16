import { createPortal } from "react-dom";
import type { SessionDetail } from "../lib/types";
import { isBuzhoushanTurnActive } from "../lib/buzhoushan-events";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createEffect, qualityFor, type EffectMode, type Pointer } from "../lib/buzhoushan-effects";
import { QUALITY_TIERS, type QualityTier } from "../lib/buzhoushan-effect-common";
import { createDemoVoice, voiceSignal } from "../lib/voice-signal";
import { SCREENSAVER_ORDER, useIdle, useScreensaverPrefs, useScreensaverRequests } from "../lib/buzhoushan-idle";
import { useVoiceStatus } from "../lib/voice-status";
import { workbenchItems } from "./BuzhoushanActivity";
import { t } from "../i18n";

function taskStatus(detail?: SessionDetail) {
  if (!detail || !isBuzhoushanTurnActive(detail)) return undefined;
  const { session } = detail;
  const live = !session.state.unknownFreeze && session.state.reachability !== "unreachable" && detail.hostOnline !== false;
  const label = !live ? t("运行状态待确认") : session.state.waitReason === "approval" ? t("等待确认") : session.state.waitReason === "user_input" ? t("等待回答") : t("任务执行中");
  const steps = workbenchItems(detail);
  // Only counts are shown: command text may hold secrets and this layer is broadcast.
  return { label, live, done: steps.filter(step => step.status === "completed").length, total: steps.length };
}

/** Follows the workspace (.app-shell) so the side introductions of the 16:9 canvas stay visible. */
function useWorkspaceBounds(active: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const shell = document.querySelector(".app-shell");
    if (!active || !shell) { setStyle(undefined); return; }
    const measure = () => {
      const r = shell.getBoundingClientRect();
      setStyle({ inset: "auto", left: r.left, top: r.top, width: r.width, height: r.height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(shell);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [active]);
  return style;
}

/**
 * Visual-only idle effect for the captured broadcast. It is click-through
 * (pointer-events: none), never blocks input, and leaves all other components mounted.
 */
const ORDER: EffectMode[] = SCREENSAVER_ORDER;
const CYCLE_MS = 45_000;
let cycleStart = 0;
/** Lowest tier "auto" has had to fall back to; kept so the next screensaver starts there. */
let autoTier: QualityTier = "high";

const EFFECT_LABEL: Record<EffectMode, string> = {
  glyph: "字符涟漪", particles: "粒子引力场", smoke: "流体烟雾", matrix: "数字雨",
  attractor: "吸引子轨迹", wavegrid: "波浪网格", starfield: "星空", threebody: "三体太阳轨迹", proton: "质子",
};
type Speaker = "none" | "mic" | "ai";

function voiceLine(status: { phase: string; muted: boolean; kind: string }, speaker: Speaker) {
  const who = t(status.kind === "global" ? "语音总控" : "会话语音");
  const state = status.phase === "connecting" ? t("连接中…") : status.phase === "recovering" ? t("恢复连接中…") : t("已连接");
  const extra = status.phase !== "connected" ? "" : status.muted ? ` · ${t("已静音")}` : ` · ${t(speaker === "mic" ? "你在说话" : speaker === "ai" ? "AI 在说话" : "聆听中")}`;
  return `${who} ${state}${extra}`;
}

type Source = "idle" | "call" | "manual";

/**
 * The one broadcast screensaver. It is raised by the idle timer, by a connected global voice call or by the
 * toolbar button, shows task progress (or standby) plus the voice-call state, and a click or key press leaves
 * it (mouse movement does not). The arrows switch effects. It never blocks input or touches calls/tasks.
 */
export function BuzhoushanScreensaver({ detail }: { detail?: SessionDetail }) {
  const prefs = useScreensaverPrefs();
  const idle = useIdle(prefs.seconds * 1000, prefs.enabled);
  const requests = useScreensaverRequests();
  const voice = useVoiceStatus();
  const status = taskStatus(detail);
  const callLive = voice.phase === "connected" || voice.phase === "recovering";

  const [source, setSource] = useState<Source>();
  const on = source !== undefined;
  const bounds = useWorkspaceBounds(on);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState(false);
  const [toast, setToast] = useState("");
  const [speaker, setSpeaker] = useState<Speaker>("none");
  const [autoLevel, setAutoLevel] = useState<QualityTier>(autoTier);
  const tier: QualityTier = prefs.quality === "auto" ? autoLevel : prefs.quality;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<Pointer>({ x: 0.5, y: 0.5, active: false });
  const busyRef = useRef(false);
  const speakerRef = useRef<Speaker>("none");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefsRef = useRef(prefs), voiceRef = useRef(voice), sourceRef = useRef(source), idxRef = useRef(idx);
  busyRef.current = Boolean(status);
  prefsRef.current = prefs; voiceRef.current = voice; sourceRef.current = source; idxRef.current = idx;
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = (text: string, ms = 2400) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); };
  const setIndex = (next: number) => { idxRef.current = next; setIdx(next); };
  /** Which effect a fresh screensaver starts with: the glyph ripples during a call, else the configured effect. */
  const startIndex = () => {
    const phase = voiceRef.current.phase;
    if (phase === "connected" || phase === "recovering") return 0;
    const mode = prefsRef.current.mode;
    return mode === "auto" ? cycleStart % ORDER.length : Math.max(0, ORDER.indexOf(mode));
  };
  const enter = (from: Source) => {
    if (sourceRef.current) return;
    sourceRef.current = from;
    setSource(from); setPicked(false); setIndex(startIndex());
    showToast(t("屏保：← → 切换效果，点击或按键退出"), 4000);
  };
  const step = (direction: 1 | -1) => {
    const next = (idxRef.current + direction + ORDER.length) % ORDER.length;
    setPicked(true); setIndex(next);
    showToast(`${t(EFFECT_LABEL[ORDER[next]])} · ${next + 1}/${ORDER.length}`);
  };

  // Three ways in: the idle timer, a connected global call, and the toolbar button.
  useEffect(() => { if (idle) enter("idle"); }, [idle]);
  const seenSeq = useRef(voice.connectedSeq);
  useEffect(() => {
    if (voice.connectedSeq === seenSeq.current) return;
    seenSeq.current = voice.connectedSeq;
    const current = prefsRef.current;
    if (voice.kind !== "global" || !current.enabled || !current.autoVoice) return;
    // Let the call windows finish collapsing first.
    const timer = setTimeout(() => { if (sourceRef.current) { setIndex(0); setPicked(true); } else enter("call"); }, 350);
    return () => clearTimeout(timer);
  }, [voice.connectedSeq, voice.kind]);
  const seenRequests = useRef(requests);
  useEffect(() => { if (requests === seenRequests.current) return; seenRequests.current = requests; enter("manual"); }, [requests]);

  // Hanging up leaves a screensaver that the call itself raised.
  useEffect(() => { if (source === "call" && !callLive) setSource(undefined); }, [source, callLive]);
  // Leaving: a click or a key press (mouse movement does not). Arrows switch effects instead.
  useEffect(() => {
    if (!on) return;
    const end = (event: Event) => { if ((event.target as Element | null)?.closest?.(".buzhou-saver__nav")) return; setSource(undefined); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowRight" ? 1 : -1); return; }
      setSource(undefined);
    };
    // Ignore the click that raised it.
    const arm = setTimeout(() => { window.addEventListener("pointerdown", end, true); window.addEventListener("keydown", key, true); }, 400);
    return () => { clearTimeout(arm); window.removeEventListener("pointerdown", end, true); window.removeEventListener("keydown", key, true); };
  }, [on]);
  // The configured "auto" rotation, unless a call is live or the broadcaster picked an effect.
  useEffect(() => {
    if (!on || picked || prefs.mode !== "auto" || callLive) return;
    const timer = setInterval(() => { const next = (idxRef.current + 1) % ORDER.length; cycleStart = next; setIndex(next); }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [on, picked, prefs.mode, callLive]);
  const mode: EffectMode = ORDER[idx % ORDER.length];

  // The pointer attracts/repels particles and stirs smoke.
  useEffect(() => {
    if (!on) return;
    const move = (event: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      pointerRef.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, active: true };
    };
    const leave = () => { pointerRef.current = { ...pointerRef.current, active: false }; };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => { window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave); pointerRef.current = { x: 0.5, y: 0.5, active: false }; };
  }, [on]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!on || !canvas) return;
    const quality = qualityFor(tier);
    const effect = createEffect(mode, canvas, quality);
    if (!effect) return;
    const demoVoice = createDemoVoice();
    let raf = 0, last = performance.now(), size = "", frames = 0, spent = 0, windowStart = last, speakerAt = 0;
    const start = last;
    const loop = (now: number) => {
      const interval = now - last, dt = Math.min(0.05, Math.max(0.001, interval / 1000)); last = now;
      const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
      const key = `${w}x${h}@${dpr}`;
      if (w > 0 && h > 0 && size !== key) { size = key; effect.resize(w, h, dpr); }
      // Live call audio drives the effects; a screensaver raised by hand with no call plays a synthetic voice so it can be seen.
      let heard = voiceSignal.poll(now, prefsRef.current.voiceSensitivity);
      if (!heard.connected && sourceRef.current === "manual") heard = demoVoice(now);
      if (size) effect.frame(dt, (now - start) / 1000, { busy: busyRef.current, pointer: pointerRef.current, voice: heard });
      const talking: Speaker = heard.ai > 0.14 && heard.ai >= heard.mic ? "ai" : heard.mic > 0.14 ? "mic" : "none";
      if (talking !== speakerRef.current && now - speakerAt > 350) { speakerRef.current = talking; speakerAt = now; setSpeaker(talking); }
      frames++; spent += interval;
      if (now - windowStart >= 1000) {
        const fps = (frames * 1000) / spent;
        // Auto quality: after the first seconds, drop a tier if the average stays below ~40 fps.
        if (prefs.quality === "auto" && now - start > 2500 && fps < 40 && tier !== "low") {
          autoTier = QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) - 1]; setAutoLevel(autoTier); return;
        }
        frames = 0; spent = 0; windowStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); effect.dispose(); };
  }, [on, mode, tier, prefs.quality]);

  return createPortal(
    <div className="buzhou-saver" data-active={on} data-source={source} data-busy={Boolean(status)} data-mode={mode} style={bounds} aria-hidden={!on} inert={!on ? true : undefined}>
      <canvas key={mode} ref={canvasRef} className="buzhou-saver__canvas" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden="true" />
      <div className="buzhou-saver__caption" role="status">
        <span className="buzhou-saver__brand">AGENTFLEETS</span>
        {status
          ? <><strong data-live={status.live}>{status.label}</strong>{status.total > 0 && <small>{t("已完成 {0} / {1} 步", status.done, status.total)}</small>}</>
          : <strong>{t("待命中")}</strong>}
        {voice.phase !== "idle" && voice.phase !== "error" && <small className="buzhou-saver__voice" data-phase={voice.phase} data-muted={voice.muted} data-speaker={speaker}><i aria-hidden="true" />{voiceLine(voice, speaker)}</small>}
      </div>
      {toast && <div className="buzhou-saver__toast" role="status">{toast}</div>}
      {on && <>
        <button type="button" className="buzhou-saver__nav buzhou-saver__nav--left" aria-label={t("上一个效果")} onClick={() => step(-1)}><ChevronLeft size={26} /></button>
        <button type="button" className="buzhou-saver__nav buzhou-saver__nav--right" aria-label={t("下一个效果")} onClick={() => step(1)}><ChevronRight size={26} /></button>
      </>}
    </div>, document.body);
}
