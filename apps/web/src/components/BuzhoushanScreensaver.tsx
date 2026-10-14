import { createPortal } from "react-dom";
import type { SessionDetail } from "../lib/types";
import { isBuzhoushanTurnActive } from "../lib/buzhoushan-events";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { setScreensaverPreview, useIdle, useScreensaverPreview, useScreensaverPrefs } from "../lib/buzhoushan-idle";
import { workbenchItems } from "./BuzhoushanActivity";
import { t } from "../i18n";

const SEGMENTS = 72;
const RADIUS = 150;
const SEGMENT_LENGTH = (2 * Math.PI * RADIUS) / SEGMENTS + 1.5;

/** A Möbius strip assembled from twisted segments (half turn over the full loop). */
function MobiusRing() {
  return <div className="buzhou-saver__scene" aria-hidden="true"><div className="buzhou-saver__ring">
    {Array.from({ length: SEGMENTS }, (_, index) => {
      const angle = (index / SEGMENTS) * 360;
      return <i key={index} style={{ transform: `rotateZ(${angle}deg) translateX(${RADIUS}px) rotateY(${angle / 2}deg)`, height: SEGMENT_LENGTH, animationDelay: `${-(index / SEGMENTS) * 6}s` }} />;
    })}
  </div></div>;
}

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
export function BuzhoushanScreensaver({ detail }: { detail?: SessionDetail }) {
  const prefs = useScreensaverPrefs();
  const idle = useIdle(prefs.seconds * 1000, prefs.enabled);
  const preview = useScreensaverPreview();
  const status = taskStatus(detail);
  useEffect(() => {
    if (!preview) return;
    // Ignore the click that started the preview, then end it on the next click or key.
    const end = () => setScreensaverPreview(false);
    const arm = setTimeout(() => { window.addEventListener("pointerdown", end, true); window.addEventListener("keydown", end, true); }, 300);
    return () => { clearTimeout(arm); window.removeEventListener("pointerdown", end, true); window.removeEventListener("keydown", end, true); };
  }, [preview]);
  const active = idle || preview;
  const bounds = useWorkspaceBounds(active);
  return createPortal(
    <div className="buzhou-saver" data-active={active} data-busy={Boolean(status)} style={bounds} aria-hidden={!active} inert={!active ? true : undefined}>
      <MobiusRing />
      <div className="buzhou-saver__caption" role="status">
        <span className="buzhou-saver__brand">AGENTFLEETS</span>
        {status
          ? <><strong data-live={status.live}>{status.label}</strong>{status.total > 0 && <small>{t("已完成 {0} / {1} 步", status.done, status.total)}</small>}</>
          : <strong>{t("待命中")}</strong>}
        {preview && <small>{t("效果测试中，点击任意处退出")}</small>}
      </div>
    </div>, document.body);
}
