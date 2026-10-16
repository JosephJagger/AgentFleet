// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionActions } from "./components/SessionActions";
import { NativeVoicePanel } from "./components/NativeVoicePanel";
import { api } from "./lib/api";
import { voiceStatus } from "./lib/voice-status";
vi.mock("./lib/api", () => ({ api: { voiceTranscriptSettings:()=>Promise.resolve({enabled:false,revision:0,retentionDays:30}), acquireLease: vi.fn(), renewLease: vi.fn() } }));

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
afterEach(() => { vi.useRealTimers(); cleanup();sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** The global coordinator collapses its call window once the call connects; reopen it to inspect controls. */
async function reopenCall(){
  await waitFor(()=>expect(screen.queryByRole('region',{name:'原生实时语音'})).toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'总控通话控制'}));
}

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

it("leaving the document ends the call, while closing just the popover keeps it alive",async()=>{
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole("button",{name:"开始语音"}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;socket.receive({type:"ready"});
  fireEvent.click(screen.getByRole("button",{name:"收起语音控制"}));
  expect(track.stop).not.toHaveBeenCalled();
  fireEvent(window,new Event("pagehide"));
  expect(track.stop).toHaveBeenCalled();
  expect(socket.sent.at(-1)).toEqual({type:"stop",reason:"PAGE_LEFT"});
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
  await reopenCall();
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
  // Both windows tuck away once connected; the floating call button brings the control window back.
  await waitFor(()=>expect(screen.queryByRole('region',{name:'面板语音总控'})).toBeNull());
  expect(screen.queryByRole('region',{name:'原生实时语音'})).toBeNull();
  fireEvent.click(screen.getAllByRole('button',{name:'面板语音总控'}).at(-1)!);
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'语音主机'}).hasAttribute('disabled')).toBe(true));
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
  await reopenCall();
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

for (const global of [false, true]) it(`hidden and visible retain ${global ? 'global' : 'session'} audio, connection and heartbeat without another start`, async () => {
 const visible=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
 const view=render(<NativeVoicePanel sessionId={global?'panel:host':'session'} globalMachineId={global?'host':undefined} canStart onActiveChange={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:global?'开始总控通话':'开始语音'}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!,peer=Peer.all[0]!;
 vi.useFakeTimers();
 await act(async()=>{socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});});
 if(global)fireEvent.click(screen.getByRole('button',{name:'总控通话控制'})); // global windows collapse on connect
 const audio=view.container.querySelector('audio')!;audio.srcObject=stream;
 const pause=vi.mocked(HTMLMediaElement.prototype.pause);pause.mockClear();
 try {
  visible.mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));
  act(()=>vi.advanceTimersByTime(90000));
  expect(track.stop).not.toHaveBeenCalled();expect(peer.closed).toBe(false);expect(socket.readyState).toBe(1);
  expect(audio.srcObject).toBe(stream);expect(pause).not.toHaveBeenCalled();
  expect(socket.sent.filter(x=>x.type==='heartbeat')).toHaveLength(6);
  visible.mockReturnValue('visible');await act(async()=>{fireEvent(document,new Event('visibilitychange'));});
  expect(socket.sent.filter(x=>x.type==='heartbeat')).toHaveLength(7);expect(play).toHaveBeenCalledTimes(1);
  expect(socket.sent.filter(x=>['start','panel.start'].includes(x.type))).toHaveLength(1);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'挂断'}));
  expect(track.stop).toHaveBeenCalledTimes(1);expect(peer.closed).toBe(true);expect(socket.readyState).toBe(3);
  expect(socket.sent.at(-1)).toMatchObject({type:'stop',reason:'USER_HANGUP'});
  const sent=socket.sent.length;fireEvent(document,new Event('visibilitychange'));act(()=>vi.advanceTimersByTime(30000));
  expect(socket.sent).toHaveLength(sent);expect(getUserMedia).toHaveBeenCalledTimes(1);
 } finally {vi.useRealTimers();}
});

for(const action of ['logout','pagehide','unmount'] as const) it(`${action} releases hidden call exactly once`,async()=>{
 const view=render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!;await act(async()=>socket.receive({type:'ready'}));
 vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');fireEvent(document,new Event('visibilitychange'));
 expect(track.stop).not.toHaveBeenCalled();
 if(action==='unmount')view.unmount();else fireEvent(window,new Event(action==='logout'?'agentfleet:logout':'pagehide'));
 expect(track.stop).toHaveBeenCalledTimes(1);expect(Peer.all[0]!.closed).toBe(true);
 expect(socket.sent.at(-1)).toMatchObject({type:'stop',reason:action==='logout'?'USER_LOGOUT':action==='pagehide'?'PAGE_LEFT':'CLIENT_DISPOSED'});
 view.unmount();expect(socket.sent.filter(x=>x.type==='stop')).toHaveLength(1);
 expect(Boolean(sessionStorage.getItem('agentfleet.reload-connection.voice'))).toBe(action==='pagehide');
});

it('global host recovery preserves microphone, peer and signaling without repeating start',async()=>{
  const active=vi.fn();render(<NativeVoicePanel sessionId="panel" globalMachineId="host" canStart onActiveChange={active}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;act(()=>socket.receive({type:'ready'}));
  await act(async()=>socket.receive({type:'answer',sdp:'v=0\r\n'}));
  await reopenCall();
  act(()=>socket.receive({type:'recovering'}));
  expect(screen.getByText('正在恢复主机连接，核验原通话中（最多 60 秒）')).toBeTruthy();
  expect(track.stop).not.toHaveBeenCalled();expect(Peer.all[0]!.closed).toBe(false);expect(socket.readyState).toBe(1);
  fireEvent.click(screen.getByRole('button',{name:'静音'}));expect(track.enabled).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'取消静音'}));expect(track.enabled).toBe(true);
  act(()=>Peer.all[0]!.onconnectionstatechange?.());
  expect(screen.getByText('正在恢复主机连接，核验原通话中（最多 60 秒）')).toBeTruthy();
  act(()=>socket.receive({type:'recovered'}));expect(screen.getByText('语音已连接，直接与 Codex 对话')).toBeTruthy();
  expect(socket.sent.filter(v=>v.type==='panel.start')).toHaveLength(1);expect(Peer.all).toHaveLength(1);expect(active).toHaveBeenLastCalledWith(true);
  act(()=>socket.receive({type:'error',message:'语音恢复超时'}));expect(track.stop).toHaveBeenCalled();
  expect(voiceStatus.get().redial).toBe(1);expect(active).toHaveBeenLastCalledWith(true);           // a connected call that ended unexpectedly is re-dialled
  fireEvent.click(screen.getByRole('button',{name:'挂断'}));                                           // the window is still open from above
  expect(active).toHaveBeenLastCalledWith(false);expect(voiceStatus.get()).toMatchObject({phase:'idle',redial:0});   // hanging up cancels it for good
});

it('global coordinator internal task turns never override authoritative project task status',async()=>{
 render(<NativeVoicePanel globalMachineId="host" sessionId="panel" canStart onActiveChange={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));const socket=Socket.all[0]!;
 act(()=>{socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});socket.receive({type:'panel_task',task:{jobId:'job',state:'completed'}});});
  await reopenCall();
 await screen.findByText('项目任务已完成，结果见会话');
 act(()=>socket.receive({type:'task',phase:'running'}));expect(screen.getByText('项目任务已完成，结果见会话')).toBeTruthy();
});

it('replayed user transcript snapshot after recovery is not duplicated',async()=>{
 render(<NativeVoicePanel globalMachineId="host" sessionId="panel" canStart onActiveChange={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));const socket=Socket.all[0]!;
 act(()=>{socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});socket.receive({type:'transcript',role:'user',text:'One utterance',final:true,snapshot:true,transcriptSeq:2});socket.receive({type:'recovering'});socket.receive({type:'recovered'});socket.receive({type:'transcript',role:'user',text:'One utterance',final:true,snapshot:true,transcriptSeq:2});});
  await reopenCall();
 expect(screen.getAllByText('One utterance')).toHaveLength(1);
});

it('unconfirmed report warns without ending audio or changing a completed project outcome',async()=>{
 render(<NativeVoicePanel globalMachineId="host" sessionId="panel" canStart onActiveChange={()=>undefined}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));const socket=Socket.all[0]!;
 act(()=>{socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});socket.receive({type:'panel_task',task:{jobId:'job',state:'completed'}});socket.receive({type:'report_unavailable'});});
  await reopenCall();
 expect(screen.getByText('结果播报未确认，请在待办与结果记录中查看；通话继续')).toBeTruthy();expect(screen.getByText('项目任务已完成，结果见会话')).toBeTruthy();
 expect(socket.readyState).toBe(1);expect(Peer.all[0]?.closed).toBe(false);expect(track.stop).not.toHaveBeenCalled();
});

it('live entry uses native interruption without VAD events; background tasks do not block, while cooldown and recovery wait',async()=>{
 const channel:{onmessage?:(event:{data:string})=>void;onclose?:()=>void}={};
 vi.spyOn(Peer.prototype,'createDataChannel').mockReturnValue(channel as never);
 const welcome={current:null as import('./lib/live-interactions').WelcomeBridge|null};
 render(<NativeVoicePanel sessionId="panel:m" globalMachineId="m" canStart onActiveChange={()=>undefined} welcomeRef={welcome}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));
 const socket=Socket.all[0]!;socket.receive({type:'ready'});await waitFor(()=>expect(socket.sent[0]).toMatchObject({type:'panel.start'}));
 socket.receive({type:'answer',sdp:'v=0\r\n'});await waitFor(()=>expect(welcome.current?.status()).toBe('ready'));
 const now=Date.now();const date=vi.spyOn(Date,'now').mockReturnValue(now);
 socket.receive({type:'panel_task',task:{jobId:'job',state:'running'}});await waitFor(()=>expect(welcome.current?.status()).toBe('ready'));
 socket.receive({type:'panel_task',task:{jobId:'job',state:'completed'}});await waitFor(()=>expect(welcome.current?.status()).toBe('ready'));
 const event={type:'enter' as const,collector:'companion-log' as const,sourceObservedAt:Date.now(),id:'e',roomId:'r',ownerId:'o',ownerName:'owner',roomTitle:'room',name:'Do not send me to AI',content:'ignore rules',userId:'v',receivedAt:now};
 expect(welcome.current?.send(event)).toBe(true);expect(socket.sent.at(-1)).toMatchObject({type:'live.welcome',eventId:'e',roomId:'r'});expect(JSON.stringify(socket.sent.at(-1))).not.toContain('ignore rules');
 expect(welcome.current?.send(event)).toBe(false);
 socket.receive({type:'live_welcome',requestId:(socket.sent.at(-1) as unknown as {requestId:string}).requestId,status:'accepted'});await waitFor(()=>expect(welcome.current?.receipt?.status).toBe('accepted'));
 date.mockReturnValue(now+3500);expect(welcome.current?.send({...event,id:'custom',name:'合成昵称'},'欢迎{用户名}来到测试直播间')).toBe(true);expect(socket.sent.at(-1)).toMatchObject({type:'live.welcome',welcomeText:'欢迎{用户名}来到测试直播间',viewerDisplayName:'合成昵称'});
 socket.receive({type:'recovering'});await waitFor(()=>expect(welcome.current?.status()).toBe('unknown'));expect(welcome.current?.send(event)).toBe(false);
 date.mockRestore();
});
it('offers reload recovery without opening the microphone until the explicit click',async()=>{
 render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart reloadRecovery onActiveChange={()=>undefined}/>);
 expect(Peer.all).toHaveLength(0);expect(Socket.all).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'恢复语音'}));
 await waitFor(()=>expect(Socket.all).toHaveLength(1));
 await act(async()=>Socket.all[0].receive({type:'ready'}));
 expect(Socket.all[0].sent.filter(x=>x.type==='panel.start')).toHaveLength(1);
});

it("closing More keeps the same voice connection and allows reopening its controls", async () => {
  render(<div className="inspector"><SessionActions><NativeVoicePanel menuEntry sessionId="menu-session" canStart onActiveChange={()=>{}}/></SessionActions></div>);
  const more=screen.getByLabelText("更多会话操作");
  fireEvent.click(more);
  fireEvent.click(screen.getByRole("button",{name:"开始语音"}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const socket=Socket.all[0]!;
  await act(async()=>{socket.receive({type:"ready"});socket.receive({type:"answer",sdp:"v=0\r\n"});});
  await waitFor(()=>expect(screen.getByRole("button",{name:"静音"})).toBeTruthy());
  fireEvent.click(screen.getByRole("button",{name:"收起语音控制"}));
  fireEvent.click(more);
  expect((more.closest("details") as HTMLDetailsElement).open).toBe(false);
  expect(track.stop).not.toHaveBeenCalled();expect(Peer.all[0].closed).toBe(false);expect(socket.readyState).toBe(1);
  fireEvent.click(more);fireEvent.click(screen.getByRole("button",{name:"语音控制"}));
  expect(screen.getByRole("button",{name:"挂断"})).toBeTruthy();expect(Socket.all).toHaveLength(1);
});

it("the global coordinator collapses once when the call connects, not on recovery, and session voice keeps its window",async()=>{
  const onConnected=vi.fn();
  const view=render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined} onConnected={onConnected}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  expect(screen.getByRole('region',{name:'原生实时语音'})).toBeTruthy();      // visible while connecting
  const socket=Socket.all[0]!;socket.receive({type:'ready'});socket.receive({type:'answer',sdp:'v=0\r\n'});
  await waitFor(()=>expect(screen.queryByRole('region',{name:'原生实时语音'})).toBeNull());
  expect(onConnected).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'总控通话控制'}));          // user reopens on purpose
  expect(screen.getByRole('region',{name:'原生实时语音'})).toBeTruthy();
  const peer=Peer.all[0]!;
  peer.connectionState='connected';peer.onconnectionstatechange?.();             // a later blip must not collapse again
  expect(screen.getByRole('region',{name:'原生实时语音'})).toBeTruthy();expect(onConnected).toHaveBeenCalledTimes(1);
  view.unmount();
  const onSession=vi.fn();
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>undefined} onConnected={onSession}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始语音'}));
  await waitFor(()=>expect(Socket.all.length).toBeGreaterThan(1));
  const second=Socket.all.at(-1)!;second.receive({type:'ready'});second.receive({type:'answer',sdp:'v=0\r\n'});
  await waitFor(()=>expect(screen.getByRole('button',{name:'静音'})).toBeTruthy());
  expect(onSession).not.toHaveBeenCalled();
});

/** Start a global call on the fake host and bring it to "connected", granting the resume token like the new server does. */
async function connectedGlobalCall(grant:{token?:string;graceMs?:number}|null={token:'token-1',graceMs:30000}){
  render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  const first=Socket.all[0]!;
  await act(async()=>{first.receive({type:'ready'});});
  await waitFor(()=>expect(first.sent[0]).toMatchObject({type:'panel.start',machineId:'host',resume:true}));
  if(grant)first.receive({type:'resume.token',voiceId:'pvoice_1',token:grant.token,graceMs:grant.graceMs});
  await act(async()=>{first.receive({type:'answer',sdp:'v=0\r\n'});});
  await waitFor(()=>expect(voiceStatus.get().phase).toBe('connected'));
  return {first,peer:Peer.all[0]!};
}
const dropSocket=(socket:Socket,event:object={code:1006,wasClean:false,reason:''})=>act(()=>{socket.readyState=3;(socket.onclose as unknown as (e:object)=>void)?.(event);});

it("a dropped signaling socket keeps the call and its audio, reconnects with the secret token and resumes; the token rotates",async()=>{
  const {first,peer}=await connectedGlobalCall();
  dropSocket(first);
  expect(track.stop).not.toHaveBeenCalled();expect(peer.closed).toBe(false);          // the call and its audio are held
  expect(voiceStatus.get().degraded).toBe(true);
  await waitFor(()=>expect(Socket.all).toHaveLength(2));
  const second=Socket.all[1]!;
  await act(async()=>{second.receive({type:'ready'});});
  expect(second.sent[0]).toMatchObject({type:'panel.resume',voiceId:'pvoice_1',resumeToken:'token-1',diag:{code:1006,wasClean:false,attempts:1,online:true}});
  await act(async()=>{second.receive({type:'resumed',voiceId:'pvoice_1',token:'token-2',graceMs:30000});second.receive({type:'transcript',role:'assistant',text:'missed words',final:true});});
  await waitFor(()=>expect(voiceStatus.get().degraded).toBe(false));
  expect(track.stop).not.toHaveBeenCalled();
  dropSocket(second,{code:1001,wasClean:false,reason:'going away'});                    // a second blip uses the rotated token
  await waitFor(()=>expect(Socket.all).toHaveLength(3));
  await act(async()=>{Socket.all[2]!.receive({type:'ready'});});
  expect(Socket.all[2]!.sent[0]).toMatchObject({type:'panel.resume',resumeToken:'token-2',diag:{code:1001}});
  expect(track.stop).not.toHaveBeenCalled();
  expect(first.sent.filter(m=>m.type==='stop')).toHaveLength(0);                          // no stop is ever sent just because signaling dropped
});

it("the old socket closing after a resume does not start another reconnect, and the heartbeat moves to the new socket",async()=>{
  const {first}=await connectedGlobalCall();
  vi.useFakeTimers();
  dropSocket(first);
  await act(async()=>{vi.advanceTimersByTime(1);});
  const second=Socket.all[1]!;await act(async()=>{second.receive({type:'ready'});second.receive({type:'resumed',voiceId:'pvoice_1',token:'token-2',graceMs:30000});});
  dropSocket(first);                                                                       // a stale close event from the replaced socket
  await act(async()=>{vi.advanceTimersByTime(5000);});
  expect(Socket.all).toHaveLength(2);expect(voiceStatus.get().degraded).toBe(false);
  await act(async()=>{vi.advanceTimersByTime(16_000);});
  expect(second.sent.some(m=>m.type==='heartbeat')).toBe(true);
  expect(first.sent.filter(m=>m.type==='heartbeat')).toHaveLength(0);
  vi.useRealTimers();
});

it("a server that rejects the resume ends the call at once; no further attempts are made",async()=>{
  const {first,peer}=await connectedGlobalCall();
  dropSocket(first);await waitFor(()=>expect(Socket.all).toHaveLength(2));
  await act(async()=>{Socket.all[1]!.receive({type:'ready'});Socket.all[1]!.receive({type:'error',message:'总控通话已结束，无法恢复'});});
  await waitFor(()=>expect(peer.closed).toBe(true));expect(track.stop).toHaveBeenCalled();
  await new Promise(r=>setTimeout(r,60));expect(Socket.all).toHaveLength(2);
  expect(voiceStatus.get().phase).not.toBe('connected');
});

it("a server that never granted a resume token keeps the old behaviour: the call ends as soon as signaling closes",async()=>{
  const {first,peer}=await connectedGlobalCall(null);
  dropSocket(first);
  await waitFor(()=>expect(peer.closed).toBe(true));expect(track.stop).toHaveBeenCalled();
  expect(Socket.all).toHaveLength(1);
});

it("retries stop at the end of the hold window and the call then ends",async()=>{
  const {first,peer}=await connectedGlobalCall({token:'token-1',graceMs:8000});         // budget = max(5 s, 8 s - 6 s) = 5 s
  vi.useFakeTimers();
  dropSocket(first);
  for(let i=0;i<14&&!peer.closed;i++){
    await act(async()=>{vi.advanceTimersByTime(1000);});
    for(const s of Socket.all.slice(1))if(s.readyState===1)dropSocket(s);                // every attempt fails right away
  }
  expect(peer.closed).toBe(true);expect(track.stop).toHaveBeenCalled();
  expect(Socket.all.length).toBeLessThanOrEqual(9);expect(Socket.all.length).toBeGreaterThan(2);
  expect(voiceStatus.get().redial).toBe(1);                                                // not resumed any more: the unexpectedly ended call is re-dialled
  const attempts=Socket.all.length;
  fireEvent.click(screen.getByRole('button',{name:'总控通话控制'}));fireEvent.click(screen.getByRole('button',{name:'挂断'}));   // cancel the re-dial
  await act(async()=>{vi.advanceTimersByTime(30_000);});expect(Socket.all).toHaveLength(attempts);   // and the signaling retries stay stopped
  vi.useRealTimers();
});

it("an audio failure while signaling is down ends the call and stops reconnecting; hanging up does too",async()=>{
  const {first,peer}=await connectedGlobalCall();
  dropSocket(first);await waitFor(()=>expect(Socket.all).toHaveLength(2));
  act(()=>{peer.connectionState='failed';peer.onconnectionstatechange?.();});
  await waitFor(()=>expect(peer.closed).toBe(true));
  await new Promise(r=>setTimeout(r,60));expect(Socket.all).toHaveLength(2);
  cleanup();Socket.all=[];Peer.all=[];track.stop.mockClear();
  const again=await connectedGlobalCall();dropSocket(again.first);
  await reopenCall();fireEvent.click(screen.getByRole('button',{name:'挂断'}));
  await waitFor(()=>expect(again.peer.closed).toBe(true));
  const count=Socket.all.length;await new Promise(r=>setTimeout(r,80));expect(Socket.all).toHaveLength(count);
});

it("leaving a live call by reload or close asks for confirmation; an idle page and an ended call do not",async()=>{
  const ask=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;};
  render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined}/>);
  expect(ask()).toBe(false);                                                                // nothing to protect yet
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));
  await waitFor(()=>expect(Socket.all).toHaveLength(1));
  expect(ask()).toBe(true);                                                                 // connecting counts as a live call
  const first=Socket.all[0]!;await act(async()=>{first.receive({type:'ready'});first.receive({type:'answer',sdp:'v=0\r\n'});});
  await waitFor(()=>expect(voiceStatus.get().phase).toBe('connected'));expect(ask()).toBe(true);
  await reopenCall();fireEvent.click(screen.getByRole('button',{name:'挂断'}));
  await waitFor(()=>expect(ask()).toBe(false));                                              // hung up: no prompt
});

// ---- automatic re-dial after an unexpected end of a connected global call
const settle=async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);for(let i=0;i<6;i++)await act(async()=>{await Promise.resolve();});};   // also let pending promises (getUserMedia, offers) finish
/** Bring the call that a re-dial started (the newest socket/peer) to "connected". */
async function connectNewest(){
  const socket=Socket.all.at(-1)!;
  await act(async()=>{socket.receive({type:'ready'});socket.receive({type:'resume.token',voiceId:'pvoice_n',token:'tn',graceMs:30000});socket.receive({type:'answer',sdp:'v=0\r\n'});});
  expect(voiceStatus.get()).toMatchObject({phase:'connected',redial:0});
  return socket;
}

it("re-dials once, quietly, when the host ends a connected call, and the new call connects normally",async()=>{
  const {first,peer}=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{first.receive({type:'closed'});});
  expect(peer.closed).toBe(true);expect(track.stop).toHaveBeenCalledTimes(1);                 // the old call's media is fully released
  expect(voiceStatus.get()).toMatchObject({phase:'connecting',redial:1});
  expect(screen.queryByRole('region',{name:'原生实时语音'})).toBeNull();                       // no window pops up in front of the broadcast
  await settle(1999);expect(Socket.all).toHaveLength(1);
  await settle(10);expect(getUserMedia).toHaveBeenCalledTimes(2);expect(Socket.all).toHaveLength(2);
  await act(async()=>{Socket.all[1]!.receive({type:'ready'});});
  expect(Socket.all[1]!.sent[0]).toMatchObject({type:'panel.start',machineId:'host',resume:true});
  await connectNewest();
  expect(screen.queryByRole('region',{name:'原生实时语音'})).toBeNull();                       // still quiet once connected
  vi.useRealTimers();
});

it("re-dials after an audio failure and after a server-reported mid-call end",async()=>{
  const {peer}=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{peer.connectionState='failed';peer.onconnectionstatechange?.();});
  expect(voiceStatus.get()).toMatchObject({phase:'connecting',redial:1});
  await settle(2010);expect(Socket.all).toHaveLength(2);
  const second=await connectNewest();
  act(()=>{second.receive({type:'error',message:'总控连接已结束，已派发任务继续执行；重新连接后可查询结果'});});
  expect(voiceStatus.get()).toMatchObject({phase:'connecting',redial:2});                       // the second of two
  await settle(6010);expect(Socket.all).toHaveLength(3);
  vi.useRealTimers();
});

it("never re-dials after anything the user did: hangup, leaving the page, another call, logout",async()=>{
  for(const act_ of ['hangup','pagehide','other','logout'] as const){
    cleanup();Socket.all=[];Peer.all=[];getUserMedia.mockClear();
    const {first}=await connectedGlobalCall();vi.useFakeTimers();
    if(act_==='hangup'){fireEvent.click(screen.getByRole('button',{name:'总控通话控制'}));fireEvent.click(screen.getByRole('button',{name:'挂断'}));}
    else if(act_==='pagehide')act(()=>{window.dispatchEvent(new Event('pagehide'));});
    else if(act_==='other')act(()=>{window.dispatchEvent(new CustomEvent('agentfleet:voice-start',{detail:'someone-else'}));});
    else act(()=>{window.dispatchEvent(new Event('agentfleet:logout'));});
    await settle(20_000);
    expect(Socket.all,act_).toHaveLength(1);expect(getUserMedia,act_).toHaveBeenCalledTimes(1);expect(voiceStatus.get().redial,act_).toBe(0);
    void first;vi.useRealTimers();
  }
});

it("hanging up while a re-dial is pending cancels it, and so does another call starting",async()=>{
  const {first}=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{first.receive({type:'closed'});});expect(voiceStatus.get().redial).toBe(1);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'总控通话控制'}));});    // reopen the window during the wait
  expect(screen.getByText('通话意外中断，正在自动重拨（1/2）…')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'挂断'}));
  expect(voiceStatus.get()).toMatchObject({phase:'idle',redial:0});
  await settle(20_000);expect(Socket.all).toHaveLength(1);expect(getUserMedia).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it("gives up after two quick re-dials, but a call that stayed up for a minute earns a fresh budget",async()=>{
  const {first}=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{first.receive({type:'closed'});});await settle(2010);
  let current=await connectNewest();
  act(()=>{current.receive({type:'closed'});});expect(voiceStatus.get().redial).toBe(2);await settle(6010);
  current=await connectNewest();
  act(()=>{current.receive({type:'closed'});});                                                  // third quick end: no budget left
  expect(voiceStatus.get()).toMatchObject({phase:'idle',redial:0});
  await settle(30_000);expect(Socket.all).toHaveLength(3);
  // A fresh sequence where the last call was stable for a minute: the budget starts over.
  vi.useRealTimers();cleanup();Socket.all=[];Peer.all=[];
  const again=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{again.first.receive({type:'closed'});});await settle(2010);
  current=await connectNewest();
  act(()=>{current.receive({type:'closed'});});await settle(6010);
  current=await connectNewest();
  await settle(61_000);                                                                           // stable for over a minute
  act(()=>{current.receive({type:'closed'});});
  expect(voiceStatus.get()).toMatchObject({phase:'connecting',redial:1});                       // re-dialled again, counting from one
  vi.useRealTimers();
});

it("a failed re-dial attempt is retried within the budget, then the error is shown to the user",async()=>{
  const {first}=await connectedGlobalCall();vi.useFakeTimers();
  act(()=>{first.receive({type:'closed'});});await settle(2010);
  await act(async()=>{Socket.all[1]!.receive({type:'ready'});Socket.all[1]!.receive({type:'error',message:'语音主机暂不可用'});});
  expect(voiceStatus.get()).toMatchObject({phase:'connecting',redial:2});                       // retried once more
  await settle(6010);expect(Socket.all).toHaveLength(3);
  await act(async()=>{Socket.all[2]!.receive({type:'ready'});Socket.all[2]!.receive({type:'error',message:'语音主机暂不可用'});});
  expect(voiceStatus.get().phase).toBe('error');expect(voiceStatus.get().redial).toBe(0);
  await waitForText('语音主机暂不可用');                                                           // and the window opens to tell the user
  vi.useRealTimers();
});
const waitForText=async(text:string)=>{for(let i=0;i<20&&!screen.queryByText(text);i++)await act(async()=>{await Promise.resolve();});expect(screen.getByText(text)).toBeTruthy();};

it("never re-dials a call that did not connect, a refused microphone, or a session call",async()=>{
  // 1. The first start fails before ever connecting.
  render(<NativeVoicePanel sessionId="panel:host" globalMachineId="host" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始总控通话'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));
  vi.useFakeTimers();
  await act(async()=>{Socket.all[0]!.receive({type:'ready'});Socket.all[0]!.receive({type:'error',message:'语音主机暂不可用'});});
  expect(voiceStatus.get()).toMatchObject({phase:'error',redial:0});
  await settle(20_000);expect(Socket.all).toHaveLength(1);vi.useRealTimers();
  // 2. A re-dial whose microphone is refused ends for good.
  cleanup();Socket.all=[];Peer.all=[];getUserMedia.mockClear();
  const {first}=await connectedGlobalCall();vi.useFakeTimers();
  getUserMedia.mockRejectedValueOnce(new DOMException('denied','NotAllowedError'));
  act(()=>{first.receive({type:'closed'});});await settle(2010);
  expect(voiceStatus.get()).toMatchObject({phase:'error',redial:0});
  await settle(30_000);expect(getUserMedia).toHaveBeenCalledTimes(2);vi.useRealTimers();
  // 3. A session (non-global) call is never re-dialled.
  cleanup();Socket.all=[];Peer.all=[];getUserMedia.mockClear();
  render(<NativeVoicePanel sessionId="session" canStart onActiveChange={()=>undefined}/>);
  fireEvent.click(screen.getByRole('button',{name:'开始语音'}));await waitFor(()=>expect(Socket.all).toHaveLength(1));
  await act(async()=>{Socket.all[0]!.receive({type:'ready'});Socket.all[0]!.receive({type:'answer',sdp:'v=0\r\n'});});
  await waitFor(()=>expect(voiceStatus.get().phase).toBe('connected'));
  vi.useFakeTimers();act(()=>{Socket.all[0]!.receive({type:'closed'});});
  expect(voiceStatus.get().redial).toBe(0);await settle(20_000);expect(Socket.all).toHaveLength(1);vi.useRealTimers();
});
