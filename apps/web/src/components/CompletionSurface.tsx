import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Desktop suggestions float outside the scrollable composer, without changing its height. */
export function CompletionSurface({ anchor, children }: { anchor: RefObject<HTMLTextAreaElement | null>; children: ReactNode }) {
  const [touch, setTouch] = useState(() => window.matchMedia?.("(max-width: 900px), (pointer: coarse)").matches ?? false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320, height: 206 });
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px), (pointer: coarse)");
    const change = () => setTouch(media?.matches ?? false);
    media?.addEventListener?.("change", change);
    return () => media?.removeEventListener?.("change", change);
  }, []);
  useLayoutEffect(() => {
    if (touch) return;
    const input = anchor.current;
    const surface = input?.closest(".composer-input");
    if (!surface) return;
    const update = () => {
      const rect = surface.getBoundingClientRect();
      const next = { left: Math.max(8, rect.left), top: rect.top - 6, width: Math.min(rect.width, window.innerWidth - 16), height: Math.max(0, Math.min(206, rect.top - 14)) };
      setPosition(previous => Object.keys(next).every(key => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(surface);
    if (input) observer?.observe(input);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [anchor, touch]);
  if (touch) return children;
  return createPortal(<div className="completion-floating" style={{ left: position.left, top: position.top, width: position.width, "--completion-height": `${position.height}px` } as CSSProperties}>{children}</div>, document.body);
}
