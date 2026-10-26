// @vitest-environment jsdom
import { act, renderHook, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useImageDraft, isInlineImage, prepareClipboardImage } from "./lib/image-drafts";
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
function Draft({session="a"}:{session?:string}) {const draft=useImageDraft("user",session); return <><textarea aria-label="paste" onPaste={draft.onPaste}/><input aria-label="upload" type="file" onChange={event=>void draft.addFiles(Array.from(event.currentTarget.files??[]))}/><span>{draft.processing?"processing":"ready"}</span><output>{JSON.stringify(draft.images)}</output><p>{draft.error}</p><button onClick={()=>draft.remove(0)}>remove</button></>;}
function clipboard() {return {items:[{kind:"file",type:"image/png",getAsFile:()=>new File(["fixture"],"clipboard.png",{type:"image/png"})}]};}
function mocks(decode:()=>Promise<void>=async()=>{}) {
  vi.stubGlobal("Image",class {src="";naturalWidth=1;naturalHeight=1;decode=decode;});
  vi.stubGlobal("URL",{createObjectURL:()=>"blob:fixture",revokeObjectURL:vi.fn()});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:()=>{}} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback=>callback(new Blob([Uint8Array.from(atob(png.split(",")[1]),c=>c.charCodeAt(0))],{type:"image/png"})));
}
it("pastes raster bytes, persists preview and removes it without changing text paste",async()=>{
  mocks();render(<Draft/>);fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("data:image/png"));
  expect(localStorage.getItem("agentfleet.images:user:a")).toContain("data:image/png");
  fireEvent.click(screen.getByText("remove"));expect(localStorage.getItem("agentfleet.images:user:a")).toBeNull();
  expect(fireEvent.paste(screen.getByRole("textbox"),{clipboardData:{items:[]}})).toBe(true);
});
it("adds an image selected from a mobile file picker",async()=>{
  mocks();render(<Draft/>);
  fireEvent.change(screen.getByLabelText("upload"),{target:{files:[new File(["fixture"],"photo.webp",{type:"image/webp"})]}});
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("data:image/png"));
  expect(localStorage.getItem("agentfleet.images:user:a")).toContain("data:image/png");
});
it("falls back to JPEG when a mobile browser cannot encode WebP and PNG remains too large",async()=>{
  mocks();
  const oversizedPng = new Blob([new Uint8Array(129 * 1024)], {type:"image/png"});
  const jpeg = new Blob([Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,0,255,217])], {type:"image/jpeg"});
  const encoded: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation((callback,type)=>{
    encoded.push(type ?? "");
    callback(type === "image/jpeg" ? jpeg : oversizedPng);
  });
  const result = await prepareClipboardImage(new File(["mobile photo"],"photo.png",{type:"image/png"}));
  expect(result.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(encoded).toEqual(["image/png","image/webp","image/jpeg"]);
});
it("a paste finishing after switching sessions stays in its original conversation",async()=>{
  let finish!:()=>void;mocks(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<Draft/>);fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});
  view.rerender(<Draft session="b"/>);await act(async()=>finish());
  await waitFor(()=>expect(localStorage.getItem("agentfleet.images:user:a")).toContain(png));
  await waitFor(()=>expect(screen.getByText("ready")).toBeTruthy());
  expect(screen.getByRole("status").textContent).toBe("[]");expect(localStorage.getItem("agentfleet.images:user:b")).toBeNull();
  view.rerender(<Draft/>);expect(screen.getByRole("status").textContent).toContain(png);
});
it("restored image drafts remain isolated and reject remote URLs or too many images",()=>{
  localStorage.setItem("agentfleet.images:user:a",JSON.stringify([png]));
  const view=render(<Draft/>);expect(screen.getByRole("status").textContent).toContain(png);
  view.rerender(<Draft session="b"/>);expect(screen.getByRole("status").textContent).toBe("[]");
  expect(isInlineImage("https://tracking.test/pixel.png")).toBe(false);
  view.unmount();localStorage.setItem("agentfleet.images:user:b",JSON.stringify(Array(4).fill(png)));render(<Draft session="b"/>);
  fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});expect(screen.getByText(/最多 4 张/)).toBeTruthy();
});

const file = () => new File(["fixture"], "screenshot.png", { type: "image/png" });
it("keeps two screenshots through loading gaps, other chats, and composer remounts", async () => {
  mocks();
  const first = renderHook(({session}: {session?: string}) => useImageDraft("roundtrip", session), {initialProps: {session: "worktree"} as {session?: string}});
  await act(async () => first.result.current.addFiles([file(), file()]));
  first.rerender({session: undefined});expect(first.result.current.images).toEqual([]);
  first.rerender({session: "main"});expect(first.result.current.images).toEqual([]);
  await act(async () => first.result.current.addFiles([file()]));
  first.rerender({session: "worktree"});expect(first.result.current.images).toHaveLength(2);
  first.unmount();
  const restored = renderHook(() => useImageDraft("roundtrip", "worktree"));
  expect(restored.result.current.images).toHaveLength(2);
});
it("finishes processing after unmount and restores to the original owner only", async () => {
  let finish!: () => void; let first = true; mocks(() => { if (!first) return Promise.resolve(); first = false; return new Promise(resolve => { finish = resolve; }); });
  const original = renderHook(() => useImageDraft("background", "worktree"));
  let adding!: Promise<void>;
  act(() => { adding = original.result.current.addFiles([file(), file()]); });
  original.unmount();
  const other = renderHook(() => useImageDraft("other-account", "worktree"));
  const restored = renderHook(() => useImageDraft("background", "worktree"));
  expect(restored.result.current.processing).toBe(true);
  await act(async () => { finish(); await adding; });
  expect(restored.result.current.images).toHaveLength(2);
  expect(restored.result.current.processing).toBe(false);
  expect(other.result.current.images).toEqual([]);
});
it("keeps a memory fallback across remounts when browser storage is full", async () => {
  mocks();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  const original = renderHook(() => useImageDraft("quota", "worktree"));
  await act(async () => original.result.current.addFiles([file(), file()]));
  expect(original.result.current.error).toContain("不要刷新");
  original.unmount();
  const restored = renderHook(() => useImageDraft("quota", "worktree"));
  expect(restored.result.current.images).toHaveLength(2);
  expect(restored.result.current.error).toContain("不要刷新");
  act(() => restored.result.current.remove(0));expect(restored.result.current.images).toHaveLength(1);
  act(() => restored.result.current.clear());expect(restored.result.current.images).toEqual([]);
});
it("clearing a draft prevents unfinished processing from resurrecting it", async () => {
  let finish!: () => void; mocks(() => new Promise(resolve => { finish = resolve; }));
  const view = renderHook(() => useImageDraft("clear", "worktree"));
  let adding!: Promise<void>;
  act(() => { adding = view.result.current.addFiles([file()]); });
  act(() => view.result.current.clear());
  await act(async () => { finish(); await adding; });
  expect(view.result.current.images).toEqual([]);
  expect(view.result.current.processing).toBe(false);
  expect(localStorage.getItem("agentfleet.images:clear:worktree")).toBeNull();
});
