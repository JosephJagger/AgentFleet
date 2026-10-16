import { createPortal } from "react-dom";
import type { SessionDetail } from "../lib/types";
import { isBuzhoushanTurnActive } from "../lib/buzhoushan-events";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createEffect, qualityFor, type EffectMode, type Pointer } from "../lib/buzhoushan-effects";
import { QUALITY_TIERS, describeGpu, type QualityTier } from "../lib/buzhoushan-effect-common";
import { createDemoVoice, voiceSignal } from "../lib/voice-signal";
import { SCREENSAVER_EFFECTS, VOICE_STYLES, saveScreensaverPrefs, setScreensaverPreview, useIdle, useScreensaverPreview, useScreensaverPrefs } from "../lib/buzhoushan-idle";
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
const CYCLE: EffectMode[] = SCREENSAVER_EFFECTS;
const CYCLE_MS = 45_000;
let cycleStart = 0;
/** Lowest tier "auto" has had to fall back to; kept so the next screensaver starts there. */
let autoTier: QualityTier = "high";
const TIER_LABEL: Record<QualityTier, string> = { low: "低", medium: "中", high: "高" };

const EFFECT_LABEL: Record<EffectMode, string> = {
  glyph: "字符涟漪", rings: "声波环", sonogram: "声纹谱图", particles: "粒子引力场", smoke: "流体烟雾", matrix: "数字雨",
  attractor: "吸引子轨迹", wavegrid: "波浪网格", starfield: "星空", threebody: "三体太阳轨迹", proton: "质子",
};
type Speaker = "none" | "mic" | "ai";

function voiceLine(status: { phase: string; muted: boolean; kind: string }, speaker: Speaker) {
  const who = t(status.kind === "global" ? "语音总控" : "会话语音");
  const state = status.phase === "connecting" ? t("连接中…") : status.phase === "recovering" ? t("恢复连接中…") : t("已连接");
  const extra = status.phase !== "connected" ? "" : status.muted ? ` · ${t("已静音")}` : ` · ${t(speaker === "mic" ? "你在说话" : speaker === "ai" ? "AI 在说话" : "聆听中")}`;
  return `${who} ${state}${extra}`;
}

function gpuLine(diag: { fps: number; w: number; h: number; dpr: number; voice: boolean }, tier: QualityTier) {
  const gpu = describeGpu();
  const base = `${t("帧率 {0} fps", diag.fps)} · ${diag.w}×${diag.h} @${diag.dpr}x · ${t("画质")} ${t(TIER_LABEL[tier])} · ${t(diag.voice ? "语音联动：已连接" : "语音联动：未连接（演示声音）")}`;
  if (!gpu.renderer) return `${base} · ${t("WebGL 不可用，可能未开启硬件加速")}`;
  return `${base} · ${gpu.renderer}${gpu.software ? ` · ${t("软件渲染，请在浏览器设置中开启硬件加速")}` : ""}`;
}

export function BuzhoushanScreensaver({ detail }: { detail?: SessionDetail }) {
  const prefs = useScreensaverPrefs();
  const idle = useIdle(prefs.seconds * 1000, prefs.enabled);
  const preview = useScreensaverPreview();
  const status = taskStatus(detail);
  const [previewMode, setPreviewMode] = useState<EffectMode>();
  const [cycle, setCycle] = useState(cycleStart);
  const [autoLevel, setAutoLevel] = useState<QualityTier>(autoTier);
  const [diag, setDiag] = useState<{ fps: number; w: number; h: number; dpr: number; voice: boolean }>();
  const tier: QualityTier = prefs.quality === "auto" ? autoLevel : prefs.quality;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef(false);
  previewRef.current = preview;
  const pointerRef = useRef<Pointer>({ x: 0.5, y: 0.5, active: false });
  const busyRef = useRef(false);
  const speakerRef = useRef<Speaker>("none");
  busyRef.current = Boolean(status);

  // Voice-call screensaver: entered when a global call connects; only a click or key press leaves it.
  const voice = useVoiceStatus();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [voiceOn, setVoiceOn] = useState(false);
  const active = idle || preview || voiceOn;
  const bounds = useWorkspaceBounds(active);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [toast, setToast] = useState("");
  const [speaker, setSpeaker] = useState<Speaker>("none");
  const seenSeq = useRef(voice.connectedSeq);
  const showToast = (text: string, ms = 2400) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); };
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (voice.connectedSeq === seenSeq.current) return;
    seenSeq.current = voice.connectedSeq;
    const current = prefsRef.current;
    if (voice.kind !== "global" || !current.enabled || !current.autoVoice) return;
    // Let the call windows finish collapsing first.
    const timer = setTimeout(() => {
      setVoiceIdx(Math.max(0, VOICE_STYLES.indexOf(current.voiceStyle)));
      setVoiceOn(true);
      showToast(t("声纹屏保：← → 切换样式，点击或按键退出"), 5000);
    }, 350);
    return () => clearTimeout(timer);
  }, [voice.connectedSeq, voice.kind]);
  // Hanging up (or a failed connection) leaves the voice screensaver.
  useEffect(() => { if (voiceOn && voice.phase !== "connected" && voice.phase !== "recovering") setVoiceOn(false); }, [voiceOn, voice.phase]);
  const stepVoice = (direction: 1 | -1) => {
    setVoiceIdx(index => {
      const next = (index + direction + VOICE_STYLES.length) % VOICE_STYLES.length;
      saveScreensaverPrefs({ ...prefsRef.current, voiceStyle: VOICE_STYLES[next] });
      showToast(`${t(EFFECT_LABEL[VOICE_STYLES[next]])} · ${next + 1}/${VOICE_STYLES.length}`);
      return next;
    });
  };
  useEffect(() => {
    if (!voiceOn) return;
    const end = (event: Event) => { if ((event.target as Element | null)?.closest?.(".buzhou-saver__nav")) return; setVoiceOn(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); stepVoice(event.key === "ArrowRight" ? 1 : -1); return; }
      setVoiceOn(false);
    };
    // Mouse movement does not leave this mode; only a click or a key does.
    const arm = setTimeout(() => { window.addEventListener("pointerdown", end, true); window.addEventListener("keydown", key, true); }, 400);
    return () => { clearTimeout(arm); window.removeEventListener("pointerdown", end, true); window.removeEventListener("keydown", key, true); };
  }, [voiceOn]);

  // Preview: number keys or arrow keys choose an effect; any other key or a click ends it.
  useEffect(() => {
    if (!preview) { setPreviewMode(undefined); return; }
    const end = () => setScreensaverPreview(false);
    const key = (event: KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < CYCLE.length) { setPreviewMode(CYCLE[index]); return; }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        const step = event.key === "ArrowRight" ? 1 : CYCLE.length - 1;
        setPreviewMode(current => CYCLE[(CYCLE.indexOf(current ?? CYCLE[0]) + step) % CYCLE.length]);
        return;
      }
      end();
    };
    // Ignore the click that started the preview.
    const arm = setTimeout(() => { window.addEventListener("pointerdown", end, true); window.addEventListener("keydown", key, true); }, 300);
    return () => { clearTimeout(arm); window.removeEventListener("pointerdown", end, true); window.removeEventListener("keydown", key, true); };
  }, [preview]);
  useEffect(() => {
    if (!active || prefs.mode !== "auto" || preview || voiceOn) return;
    const timer = setInterval(() => setCycle(value => { cycleStart = value + 1; return value + 1; }), CYCLE_MS);
    return () => clearInterval(timer);
  }, [active, prefs.mode, preview, voiceOn]);
  const mode: EffectMode = voiceOn ? VOICE_STYLES[voiceIdx] : previewMode ?? (prefs.mode === "auto" ? CYCLE[cycle % CYCLE.length] : prefs.mode);

  // The pointer attracts/repels particles and stirs smoke; an idle screensaver ends on any movement, so this matters while previewing.
  useEffect(() => {
    if (!active) return;
    const move = (event: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      pointerRef.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, active: true };
    };
    const leave = () => { pointerRef.current = { ...pointerRef.current, active: false }; };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => { window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave); pointerRef.current = { x: 0.5, y: 0.5, active: false }; };
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
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
      // Live call audio drives the effects; the preview plays a synthetic voice when no call is connected.
      let voice = voiceSignal.poll(now);
      if (!voice.connected && previewRef.current) voice = demoVoice(now);
      if (size) effect.frame(dt, (now - start) / 1000, { busy: busyRef.current, pointer: pointerRef.current, voice });
      const talking: Speaker = voice.ai > 0.14 && voice.ai >= voice.mic ? "ai" : voice.mic > 0.14 ? "mic" : "none";
      if (talking !== speakerRef.current && now - speakerAt > 350) { speakerRef.current = talking; speakerAt = now; setSpeaker(talking); }
      frames++; spent += interval;
      if (now - windowStart >= 1000) {
        const fps = (frames * 1000) / spent;
        // Auto quality: after the first seconds, drop a tier if the average stays below ~40 fps.
        if (prefs.quality === "auto" && now - start > 2500 && fps < 40 && tier !== "low") {
          autoTier = QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) - 1]; setAutoLevel(autoTier); return;
        }
        if (previewRef.current) setDiag({ fps: Math.round(fps), w, h, dpr, voice: voiceSignal.connected });
        frames = 0; spent = 0; windowStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); effect.dispose(); };
  }, [active, mode, tier, prefs.quality]);

  return createPortal(
    <div className="buzhou-saver" data-active={active} data-busy={Boolean(status)} data-mode={mode} style={bounds} aria-hidden={!active} inert={!active ? true : undefined}>
      <canvas key={mode} ref={canvasRef} className="buzhou-saver__canvas" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden="true" />
      <div className="buzhou-saver__caption" role="status">
        <span className="buzhou-saver__brand">AGENTFLEETS</span>
        {status
          ? <><strong data-live={status.live}>{status.label}</strong>{status.total > 0 && <small>{t("已完成 {0} / {1} 步", status.done, status.total)}</small>}</>
          : <strong>{t("待命中")}</strong>}
        {voice.phase !== "idle" && voice.phase !== "error" && <small className="buzhou-saver__voice" data-phase={voice.phase} data-muted={voice.muted} data-speaker={speaker}><i aria-hidden="true" />{voiceLine(voice, speaker)}</small>}
        {preview && <small>{t("效果测试：数字键 1–9 或 ←/→ 切换，点击退出")}</small>}
        {preview && diag && <small className="buzhou-saver__diag">{gpuLine(diag, tier)}</small>}
      </div>
      {toast && <div className="buzhou-saver__toast" role="status">{toast}</div>}
      {voiceOn && <>
        <button type="button" className="buzhou-saver__nav buzhou-saver__nav--left" aria-label={t("上一个声纹")} onClick={() => stepVoice(-1)}><ChevronLeft size={26} /></button>
        <button type="button" className="buzhou-saver__nav buzhou-saver__nav--right" aria-label={t("下一个声纹")} onClick={() => stepVoice(1)}><ChevronRight size={26} /></button>
      </>}
    </div>, document.body);
}
