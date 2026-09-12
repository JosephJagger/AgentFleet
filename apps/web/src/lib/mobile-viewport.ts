import { useEffect } from "react";

/** Follow the visible viewport when a mobile keyboard resizes or pans Safari. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    let restingHeight = Math.max(window.innerHeight, viewport.height);
    let restingWidth = window.innerWidth;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = document.documentElement;
        // Do not fight pinch zoom. Layout should retain its unzoomed dimensions.
        if (viewport.scale !== 1) return;
        root.style.setProperty("--visible-height", `${viewport.height}px`);
        root.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
        const editing = document.activeElement?.matches("textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]") ?? false;
        // Chromium can resize both viewports, so their difference alone misses the keyboard.
        if (Math.abs(window.innerWidth - restingWidth) > 80) {
          restingWidth = window.innerWidth;
          restingHeight = window.innerHeight;
        }
        if (!editing) restingHeight = Math.max(window.innerHeight, viewport.height);
        const keyboardOpen = window.innerHeight - viewport.height > 120 || (editing && restingHeight - viewport.height > 120);
        root.toggleAttribute("data-keyboard-open", keyboardOpen);
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--visible-height");
      document.documentElement.style.removeProperty("--visible-top");
      document.documentElement.removeAttribute("data-keyboard-open");
    };
  }, []);
}
