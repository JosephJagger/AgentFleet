// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeVoicePanel } from "./components/NativeVoicePanel";
import { api } from "./lib/api";
vi.mock("./lib/api", () => ({ api: { acquireLease: vi.fn(), renewLease: vi.fn() } }));

class Peer {
  static all: Peer[] = [];
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription = { type: "offer", sdp: "v=0\r\nm=audio 9\r\n" };
  ontrack: unknown;
  onconnectionstatechange?: () => void;
  closed = false;
  constructor() { Peer.all.push(this); }
  addTrack() {}
  createDataChannel() {}
  createOffer() { return Promise.resolve(this.localDescription); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { this.connectionState = "connected"; this.onconnectionstatechange?.(); return Promise.resolve(); }
  close() { this.closed = true; }
}
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  sent: { type: string }[] = [];
  constructor() { Socket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const track = { stop: vi.fn(), enabled: true };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
const getUserMedia = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>undefined); Peer.all = []; Socket.all = []; track.enabled = true;
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("WebSocket", Socket);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
  vi.mocked(api.acquireLease).mockResolvedValue({ lease: { id: "lease", version: 1 } } as Awaited<ReturnType<typeof api.acquireLease>>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("microphone opens only on explicit start; native answer connects, mute works, and ending closes all media", async () => {
  const active = vi.fn();
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={active} />);
  expect(getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  const socket = Socket.all[0]!; socket.receive({ type: "ready" });
  await waitFor(() => expect(socket.sent[0]).toMatchObject({ type: "start", logicalSessionId: "session", leaseId: "lease" }));
  socket.receive({ type: "answer", sdp: "v=0\r\n" });
  await waitFor(() => expect(screen.getByRole("button", { name: "静音" }).getAttribute("disabled")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "静音" }));
  expect(track.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
  expect(track.enabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "结束语音" }));
  expect(track.stop).toHaveBeenCalled(); expect(Peer.all[0]?.closed).toBe(true);
  expect(socket.sent.at(-1)).toEqual({ type: "stop" }); expect(socket.readyState).toBe(3);
  expect(active).toHaveBeenLastCalledWith(false);
});

it("cancelling while permission is pending stops late microphone tracks and never creates a connection", async () => {
  let resolve!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>(r => { resolve = r; }));
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "结束语音" })); resolve(stream);
  await waitFor(() => expect(track.stop).toHaveBeenCalled());
  expect(Peer.all).toHaveLength(0); expect(Socket.all).toHaveLength(0);
});

it("denied permission shows a readable error; switching sessions closes media and ignores late signaling", async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  const view = render(<NativeVoicePanel sessionId="one" canStart onActiveChange={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("请允许麦克风"));
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  view.unmount(); Socket.all[0]!.receive({ type: "answer", sdp: "late" });
  expect(track.stop).toHaveBeenCalled(); expect(Peer.all[0]?.closed).toBe(true);
});

it("busy sessions cannot start voice", () => {
  render(<NativeVoicePanel sessionId="one" canStart={false} onActiveChange={() => undefined} />);
  expect(screen.getByRole("button", { name: "开始语音" }).hasAttribute("disabled")).toBe(true);
  expect(getUserMedia).not.toHaveBeenCalled();
});
