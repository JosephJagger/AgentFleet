import { useLayoutEffect, useRef, useState, type RefObject, type PointerEvent, type CSSProperties } from "react";

/** Drag only from the header; use viewport coordinates, including root CSS zoom. */
export function useDraggablePanel(panel: RefObject<HTMLElement | null>, visible: boolean) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const current = useRef(position);
  const drag = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const move = (dx: number, dy: number) => {
    const element = panel.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const scale = rect.width / element.offsetWidth || 1;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const x = Math.max(left + 8, Math.min(rect.left + dx, left + width - rect.width - 8));
    const y = Math.max(top + 8, Math.min(rect.top + dy, top + height - Math.min(rect.height, height - 16) - 8));
    current.current = { x: current.current.x + (x - rect.left) / scale, y: current.current.y + (y - rect.top) / scale };
    // Apply immediately so consecutive pointer events measure the latest bounds.
    element.style.translate = `${current.current.x}px ${current.current.y}px`;
    setPosition(current.current);
  };
  useLayoutEffect(() => {
    if (!visible) { drag.current = undefined; return; }
    const clamp = () => move(0, 0);
    clamp();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(clamp) : undefined;
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", clamp);
    window.visualViewport?.addEventListener("resize", clamp);
    return () => { observer?.disconnect(); window.removeEventListener("resize", clamp); window.visualViewport?.removeEventListener("resize", clamp); };
  }, [visible]);
  const end = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    style: { translate: `${position.x}px ${position.y}px` } as CSSProperties,
    handle: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button,a,input,select,textarea")) return;
        event.preventDefault();
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const previous = drag.current;
        if (!previous || previous.id !== event.pointerId) return;
        move(event.clientX - previous.x, event.clientY - previous.y);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      },
      onPointerUp: end, onPointerCancel: end,
      onLostPointerCapture: () => { drag.current = undefined; },
    },
  };
}
