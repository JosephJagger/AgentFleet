import { t } from "../i18n";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, type ReactNode } from "react";
import type { TimelineEvent } from "../lib/types";
import { useFollowScroll } from "../lib/follow-scroll";

export function ConversationViewport({ events, children, wholeMessagesDuringHeartbeat = false }: { events: TimelineEvent[]; children: ReactNode; wholeMessagesDuringHeartbeat?: boolean }) {
  const last = events.at(-1);
  const scroll = useFollowScroll(JSON.stringify(last ? [last.id, last.body, last.command, last.output, last.diff, last.images, last.payloadState] : []));
  useLayoutEffect(() => {
    if (!wholeMessagesDuringHeartbeat) return;
    const view = scroll.viewport.current;
    const content = scroll.content.current;
    if (!view || !content) return;
    const restore = (node: HTMLElement) => {
      node.removeAttribute("data-heartbeat-clipped");
      node.removeAttribute("aria-hidden");
      node.inert = false;
    };
    const update = () => {
      const active = scroll.following && Boolean(content.querySelector('.buzhou-heartbeat[data-mode="heartbeat"]'));
      const bounds = view.getBoundingClientRect();
      for (const node of content.querySelectorAll<HTMLElement>('article[data-scroll-anchor]')) {
        const rect = node.getBoundingClientRect();
        const intersects = rect.bottom > bounds.top && rect.top < bounds.bottom;
        const clipped = rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
        if (active && intersects && clipped) {
          // Preserve geometry: removing the item would change scroll position and
          // repeatedly toggle fit. Reading history restores the original item.
          node.setAttribute("data-heartbeat-clipped", "true");
          node.setAttribute("aria-hidden", "true");
          node.inert = true;
        } else if (node.hasAttribute("data-heartbeat-clipped")) restore(node);
      }
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(view);
    resize?.observe(content);
    // Heartbeat mode changes independently of the parent and message list.
    const mutations = new MutationObserver(update);
    mutations.observe(content, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-mode"] });
    view.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      resize?.disconnect(); mutations.disconnect();
      view.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      content.querySelectorAll<HTMLElement>('[data-heartbeat-clipped]').forEach(restore);
    };
  });
  return <div className="conversation-viewport">
    <div className="timeline-scroll" ref={scroll.viewport} onScroll={scroll.onScroll} onWheelCapture={event => { if (event.deltaY < 0) scroll.pause(); }} role="region" aria-label={t("会话记录")} tabIndex={0}>
      <div ref={scroll.content}>{children}</div>
    </div>
    {!scroll.following && <button type="button" className="timeline-jump" onClick={scroll.jumpToLatest}><ArrowDown size={14} aria-hidden="true" />{scroll.hasNewContent ? t("新消息") : t("回到最新")}</button>}
  </div>;
}
