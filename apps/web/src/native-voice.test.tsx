// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const view = render(<div className="inspector"><header><NativeVoicePanel sessionId="session" canStart onActiveChange={active} /></header><form className="composer" /></div>);
  expect(getUserMedia).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  const socket = Socket.all[0]!; socket.receive({ type: "ready" });
  await waitFor(() => expect(socket.sent[0]).toMatchObject({ type: "start", logicalSessionId: "session", leaseId: "lease" }));
  socket.receive({ type: "answer", sdp: "v=0\r\n" });
  await waitFor(() => expect(screen.getByRole("button", { name: "静音" }).getAttribute("disabled")).toBeNull());
  expect(screen.getByText("尚未派发项目任务")).toBeTruthy();
  socket.receive({ type: "task", phase: "delegated" });
  await waitFor(() => expect(screen.getByText("已派发，等待项目任务启动")).toBeTruthy());
  socket.receive({ type: "task", phase: "running" });
  await waitFor(() => expect(screen.getByText("项目任务正在执行")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "收起语音控制" }));
  expect(screen.queryByRole("button", { name: "挂断" })).toBeNull();
  expect(track.stop).not.toHaveBeenCalled();
  expect(socket.readyState).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "语音控制" }));
  expect(view.container.querySelector(".inspector > .native-voice__popover")).toBeTruthy();
  expect(view.container.querySelector(".composer .native-voice")).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "静音" }));
  fireEvent.click(screen.getByRole("button", { name: "静音" }));
  expect(track.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
  expect(track.enabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "挂断" }));
  expect(track.stop).toHaveBeenCalled(); expect(Peer.all[0]?.closed).toBe(true);
  expect(socket.sent.at(-1)).toMatchObject({ type: "stop", reason: "USER_HANGUP" }); expect(socket.readyState).toBe(3);
  expect(active).toHaveBeenLastCalledWith(false);
});

it("cancelling while permission is pending stops late microphone tracks and never creates a connection", async () => {
  let resolve!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>(r => { resolve = r; }));
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "挂断" })); resolve(stream);
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

it("a brief cellular audio disconnection recovers without stopping the microphone", async () => {
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  Socket.all[0]!.receive({ type: "answer", sdp: "v=0\r\n" });
  await waitFor(() => expect(screen.getByRole("button", { name: "静音" }).hasAttribute("disabled")).toBe(false));
  vi.useFakeTimers();
  try {
    const peer = Peer.all[0]!;
    peer.connectionState = "disconnected"; peer.onconnectionstatechange?.();
    vi.advanceTimersByTime(2_000);
    peer.connectionState = "connected"; peer.onconnectionstatechange?.();
    vi.advanceTimersByTime(9_000);
    expect(track.stop).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    peer.connectionState = "disconnected"; peer.onconnectionstatechange?.();
    act(() => vi.advanceTimersByTime(8_000));
    expect(track.stop).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("音频连接中断");
  } finally { vi.useRealTimers(); }
});

it("signaling failures are distinguished from audio failures and stop the microphone", async () => {
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "开始语音" }));
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "收起语音控制" }));
  act(() => Socket.all[0]!.onerror?.());
  expect(screen.getByRole("alert").textContent).toContain("信令连接失败");
  expect(track.stop).toHaveBeenCalled();
  expect(Peer.all[0]!.closed).toBe(true);
});

it("acquires fresh control after microphone preparation and keeps alive without separate HTTP renewals",async()=>{
  let resolve!: (value:MediaStream)=>void;
  getUserMedia.mockReturnValueOnce(new Promise<MediaStream>(r=>{resolve=r;}));
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole("button",{name:"开始语音"}));
  await waitFor(()=>expect(getUserMedia).toHaveBeenCalled());
  expect(api.acquireLease).not.toHaveBeenCalled();
  resolve(stream);
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;
  vi.useFakeTimers();
  try {
    await act(async()=>{socket.receive({type:"ready"});socket.receive({type:"answer",sdp:"v=0\r\n"});});
    expect(screen.getByRole("button",{name:"静音"}).hasAttribute("disabled")).toBe(false);
    expect(socket.sent[0]).toMatchObject({type:"start",controlHeartbeat:true});
    act(()=>vi.advanceTimersByTime(90000));
    expect(socket.sent.filter(m=>m.type==="heartbeat")).toHaveLength(6);
    expect(api.renewLease).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});

it("hiding the page ends the call, while closing just the popover keeps it alive",async()=>{
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole("button",{name:"开始语音"}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;socket.receive({type:"ready"});
  fireEvent.click(screen.getByRole("button",{name:"收起语音控制"}));
  expect(track.stop).not.toHaveBeenCalled();
  fireEvent(window,new Event("pagehide"));
  expect(track.stop).toHaveBeenCalled();
  expect(socket.sent.at(-1)).toEqual({type:"stop",reason:"PAGE_HIDDEN"});
});

it("audio failure reports a bounded reason and late callbacks cannot overwrite it",async()=>{
 render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"开始语音"}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!;socket.receive({type:"ready"});
 const peer=Peer.all[0]!;
 act(()=>{peer.connectionState="failed";peer.onconnectionstatechange?.();});
 expect(socket.sent.at(-1)).toEqual({type:"stop",reason:"AUDIO_FAILED"});
 act(()=>{socket.onclose?.();});
 expect(socket.sent.filter(v=>v.type==="stop")).toHaveLength(1);
 expect(screen.getByRole("alert").textContent).toContain("语音音频连接失败");
});

it("global signaling survives page content changes without acquiring a project lease",async()=>{
  const task=vi.fn();
  const view=render(<><NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined} onPanelTask={task}/><main>Hosts</main></>);
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;socket.receive({type:'ready'});
  await waitFor(()=>expect(socket.sent[0]).toMatchObject({type:'panel.start',machineId:'host'}));
  expect(api.acquireLease).not.toHaveBeenCalled();
  socket.receive({type:'answer',sdp:'v=0\r\n'});
  await waitFor(()=>expect(screen.getByRole('button',{name:'静音'})).toBeTruthy());
  view.rerender(<><NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined} onPanelTask={task}/><main>Projects</main></>);
  expect(Socket.all).toHaveLength(1);expect(socket.readyState).toBe(1);expect(track.stop).not.toHaveBeenCalled();
  act(()=>socket.receive({type:'panel_task',task:{jobId:'job',state:'running'}}));
  expect(task).toHaveBeenCalledWith({jobId:'job',state:'running'});
  expect(screen.getByText('项目任务正在执行')).toBeTruthy();
});

it("panel control keeps the chosen voice host across dashboard refreshes and target navigation",async()=>{
  const {PanelVoiceControl}=await import('./components/PanelVoiceControl');
  const open=vi.fn();
  const host={id:'host',name:'Demo',agentVersion:'0.30.69',reachability:'live'};
  const view=render(<PanelVoiceControl machines={[host] as never} onOpenSession={open}/>);
  fireEvent.click(screen.getByRole('button',{name:'面板语音总控'}));
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});
  await waitFor(()=>expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true));
  view.rerender(<PanelVoiceControl machines={[{...host,id:'other'},{...host,reachability:'stale'}] as never} onOpenSession={open}/>);
  expect(Socket.all).toHaveLength(1);expect(socket.readyState).toBe(1);expect(track.stop).not.toHaveBeenCalled();
  act(()=>socket.receive({type:'panel_task',task:{jobId:'job',sessionId:'target',title:'Target session',host:'Demo',project:'Demo',state:'running'}}));
  fireEvent.click(screen.getByRole('button',{name:'1 运行中'}));
  fireEvent.click(screen.getByRole('button',{name:'Target session Demo · Demo'}));
  expect(open).toHaveBeenCalledWith('target');expect(socket.readyState).toBe(1);
  const first={jobId:'job',sessionId:'target',title:'Target session',host:'Demo',project:'Demo',state:'completed'};
  const second={jobId:'job-two',sessionId:'target-two',title:'Second target',host:'Demo',project:'Other',state:'running'};
  act(()=>socket.receive({type:'panel_task',task:second,tasks:[second,first]}));
  expect(screen.getByText('Target session')).toBeTruthy();expect(screen.getByText('Second target')).toBeTruthy();
  expect(screen.getAllByRole('button',{name:/^(Target session Demo · Demo|Second target Demo · Other)$/})).toHaveLength(2);
  act(()=>socket.receive({type:'panel_task',task:second,tasks:[second,first]}));
  expect(screen.getAllByRole('button',{name:/^(Target session Demo · Demo|Second target Demo · Other)$/})).toHaveLength(2);
  expect(socket.readyState).toBe(1);expect(track.stop).not.toHaveBeenCalled();

});

it("panel task status failures and completion keep audio connected",async()=>{
 render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!;socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});
 await waitFor(()=>expect(screen.getByRole('button',{name:'静音'}).getAttribute('disabled')).toBeNull());
 socket.receive({type:'task_status_unavailable'});
 await waitFor(()=>expect(screen.getByText('任务状态暂不可用，通话可继续')).toBeTruthy());
 expect(socket.readyState).toBe(1);expect(track.stop).not.toHaveBeenCalled();
 socket.receive({type:'panel_task',task:{state:'completed'}});
 await waitFor(()=>expect(screen.getByText('项目任务已完成，结果见会话')).toBeTruthy());
 expect(socket.readyState).toBe(1);expect(track.stop).not.toHaveBeenCalled();
});

it('preference changes and read failures keep audio alive and clearly require reconnect to clear old context',async()=>{
 render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始语音'}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!;
 await act(async()=>{socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});socket.receive({type:'preferences',status:'loaded'});});
 expect(screen.getByText('长期偏好已加载')).toBeTruthy();
 act(()=>socket.receive({type:'preferences',status:'reconnect_required'}));
 expect(screen.getByText('偏好已更新，请挂断重连以清除旧规则上下文')).toBeTruthy();
 act(()=>socket.receive({type:'preferences',status:'unavailable'}));
 expect(screen.getByText('长期偏好暂未加载；通话仍保持连接')).toBeTruthy();
 expect(track.stop).not.toHaveBeenCalled();expect(Peer.all[0]!.closed).toBe(false);expect(socket.readyState).toBe(1);
});
