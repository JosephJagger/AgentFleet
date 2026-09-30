import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Suggestions stay outside layout on desktop and mobile, so opening them never moves the input. */
export function CompletionSurface({ anchor, children }: { anchor: RefObject<HTMLTextAreaElement | null>; children: ReactNode }) {
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320, height: 206 });
  useLayoutEffect(() => {
    const input = anchor.current;
    const surface = input?.closest(".composer-input");
    if (!surface) return;
    const settings = input?.closest(".composer")?.querySelector(".runtime-settings-bar");
    const update = () => {
      const rect = surface.getBoundingClientRect();
      // DOM rectangles use visual pixels; a body portal uses zoomed CSS pixels.
      const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const left = rect.left / scale, top = (settings?.getBoundingClientRect().top ?? rect.top) / scale;
      const next = { left: Math.max(8, left), top: top - 6, width: Math.min(rect.width / scale, window.innerWidth / scale - 16), height: Math.max(0, Math.min(206, top - (window.visualViewport?.offsetTop ?? 0) / scale - 14)) };
      setPosition(previous => Object.keys(next).every(key => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(surface);
    if(settings)observer?.observe(settings);
    if (input) observer?.observe(input);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { observer?.disconnect(); window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [anchor]);
  return createPortal(<div className="completion-floating" style={{ left: position.left, top: position.top, width: position.width, "--completion-height": `${position.height}px` } as CSSProperties}>{children}</div>, document.body);
}
