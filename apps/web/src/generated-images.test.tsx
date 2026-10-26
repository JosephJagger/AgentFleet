// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mapEvent } from "./lib/api";
import { timelineItems } from "./lib/timeline-items";
import { GeneratedImage } from "./components/GeneratedImage";
import { isInlineImage } from "./lib/image-drafts";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const native = (status = "completed", image = png) => ({ eventId: "event", sessionSeq: 2, type: "item.completed", nativeThreadId: "thread", nativeTurnId: "turn", nativeItemId: "image", payload: { item: { id: "image", type: "imageGeneration", status, content: image ? [{ type: "image", url: image }] : [] } } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("displays generated pixels directly in the conversation with enlarge and original download", () => {
  const event = mapEvent(native());
  expect(event.actor).toBe("agent"); expect(event.title).toBe("图片生成");
  const showModal = vi.fn(); const close = vi.fn();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: close });
  const { container } = render(<GeneratedImage event={event} />);
  expect(screen.getByRole("img", { name: "生成的图片" }).getAttribute("src")).toBe(png);
  expect(container.querySelector("figure > button > img")).toBeTruthy();
  expect(screen.getByRole("link", { name: "下载图片" }).getAttribute("href")).toBe(png);
  fireEvent.click(screen.getByRole("button", { name: "放大生成的图片" })); expect(showModal).toHaveBeenCalledOnce();
});
it("retains large output images without expanding pasted image limits", () => {
  const image = png.slice(0, -4) + "AAAA".repeat(50_000);
  expect(isInlineImage(image)).toBe(false);
  const event = mapEvent(native("completed", image));
  expect(event.images).toEqual([image]);
  render(<GeneratedImage event={event} />);
  expect(screen.getByRole("img", { name: "生成的图片" }).getAttribute("src")).toBe(image);
});
it("merges started/completed into one native image after replay and retains failure and unavailable states", () => {
  const started = { ...mapEvent(native("in_progress", "")), type: "item.started", sessionSeq: 1 };
  const completed = mapEvent(native());
  const events = timelineItems([completed, started]); expect(events).toHaveLength(1); expect(events[0]!.images).toEqual([png]);
  const view = render(<GeneratedImage event={started} />); expect(screen.getByRole("status").textContent).toContain("正在生成");
  view.rerender(<GeneratedImage event={mapEvent(native("failed", ""))} />); expect(screen.getByRole("status").textContent).toContain("生成失败");
  view.rerender(<GeneratedImage event={mapEvent(native("completed", ""))} />); expect(screen.getByRole("status").textContent).toContain("暂不可用");
  view.rerender(<GeneratedImage event={completed} />); fireEvent.error(screen.getByRole("img", { name: "生成的图片" }));
  expect(screen.getByRole("status").textContent).toContain("暂不可用");
});
it("never restores cleared, suppressed or deleted pixels or loads remote/SVG images", () => {
  for (const url of ["https://tracker.test/pixel.png", "file:///private.png", "data:image/svg+xml;base64,PHN2Zy8+"])
    expect(mapEvent(native("completed", url)).images).toEqual([]);
  for (const payloadState of ["deleted", "suppressed"] as const) {
    const event = mapEvent({ ...native(), payloadState }); expect(event.images).toEqual([]);
    const view = render(<GeneratedImage event={{ ...event, images: [png] }} />); expect(view.container.querySelector("img")).toBeNull(); view.unmount();
  }
  const raw = native(); raw.payload.item.content = [{ type: "text", url: "" }] as never;
  const event = { ...mapEvent(raw), body: "云端图片已清理" }; render(<GeneratedImage event={event} />);
  expect(screen.getByRole("status").textContent).toContain("已清理");
});
it("renders arbitrarily large originals through an authenticated URL without embedding image bytes", () => {
  const raw = {...native("completed", ""),logicalSessionId:"session-large"};
  Object.assign(raw.payload.item,{imageState:"streamed",imageBytes:500_000_000});
  const event = mapEvent(raw);
  const url = "/api/sessions/session-large/files?generatedEvent=event";
  expect(event.images).toEqual([url]);
  const view=render(<GeneratedImage event={event} />);
  expect(screen.getByRole("img",{name:"生成的图片"}).getAttribute("src")).toBe(url);
  expect(screen.getByRole("link",{name:"下载图片"}).getAttribute("href")).toBe(url+"&download=1");
  fireEvent.error(screen.getByRole("img",{name:"生成的图片"}));
  expect(screen.getByRole("status").textContent).toContain("主机在线");
  view.unmount();
  expect(mapEvent({...raw,payloadState:"deleted"}).images).toEqual([]);
  expect(mapEvent({...raw,logicalSessionId:"other/path"}).images).toEqual([]);
});
