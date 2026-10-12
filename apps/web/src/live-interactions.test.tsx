// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LiveInteractions} from './components/LiveInteractions';
import {parseLiveEvent,LiveCollectorStream,welcomeEligible,LiveEventLedger,WelcomeAudioGate,localCollectorUrl,type WelcomeBridge} from './lib/live-interactions';
const frame=(type=3,patch:Record<string,unknown>={},now=Date.now(),process='直播伴侣')=>JSON.stringify({Type:type,ProcessName:process,Data:JSON.stringify({RoomId:'fixture-room',MsgId:'event',Owner:null,User:{Id:'viewer',Nickname:'Fixture viewer'},Content:'我来了 <script>alert(1)</script>',CollectorSource:'companion-log',NativeMethod:type===3?'WebcastMemberMessage':'WebcastChatMessage',Action:'1',ObservedAt:new Date(now).toISOString(),...patch})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('accepts the new collector envelope with null owner, never confuses chat with member actions',()=>{
 expect(parseLiveEvent(frame(1))?.type).toBe('chat');expect(welcomeEligible(parseLiveEvent(frame())!)).toBe(true);
 for(const patch of [{CollectorSource:undefined},{CollectorSource:'other'},{NativeMethod:'WebcastChatMessage'},{Action:'2'},{Action:undefined}])expect(parseLiveEvent(frame(3,patch))).toBeNull();
 expect(parseLiveEvent(frame(6))).toBeNull();expect(parseLiveEvent(frame(3,{},Date.now(),'chrome'))).toBeNull();
 expect(parseLiveEvent(frame(3,{RoomId:''}))).toBeNull();expect(parseLiveEvent(frame(3,{MsgId:''}))).toBeNull();
 expect(parseLiveEvent(frame(3,{User:null}))).toBeNull();expect(parseLiveEvent(frame(1,{Content:null}))).toBeNull();
 expect(()=>localCollectorUrl('8888/path')).toThrow();expect(localCollectorUrl('18888')).toBe('ws://127.0.0.1:18888/');
});
it('rejects stale/replayed and invalid timestamps; uses source time for queue expiry',()=>{
 expect(parseLiveEvent(frame(3,{},10000),30001)).toBeNull();expect(parseLiveEvent(frame(3,{},40000),30000)).toBeNull();
 expect(parseLiveEvent(frame(3,{ObservedAt:'bad'},10000),10000)).toBeNull();
 expect(parseLiveEvent(frame(3,{},10000),20000)?.receivedAt).toBe(10000);
 expect(parseLiveEvent(frame(3,{},21000),20000)?.receivedAt).toBe(20000);
});
it('preserves 64-bit IDs in string or object envelopes without rounding',()=>{
 const data=JSON.parse(JSON.parse(frame()).Data);data.MsgId='9223372036854775801';data.User.Id='9223372036854775802';
 const raw=JSON.stringify(data).replace('"9223372036854775801"','9223372036854775801').replace('"9223372036854775802"','9223372036854775802');
 const e=parseLiveEvent(JSON.stringify({Type:3,ProcessName:'直播伴侣',Data:raw}));expect(e?.id).toBe('9223372036854775801');expect(e?.userId).toBe('9223372036854775802');
});
it('diagnostics distinguish no packets, invalid format/source, stale data and supported event types',()=>{
 const stream=new LiveCollectorStream();expect(stream.diagnostics.packets).toBe(0);
 for(const raw of ['bad',new ArrayBuffer(2),'a'.repeat(65537),frame(3,{},Date.now(),'chrome'),frame(6),frame(3,{CollectorSource:undefined}),frame(3,{},0)])expect(stream.read(raw).event).toBeUndefined();
 stream.read(frame(1));stream.read(frame());expect(stream.diagnostics).toMatchObject({packets:9,rejected:7,chat:1,enter:1});
 expect(stream.diagnostics.reasons).toMatchObject({format:1,binary:1,oversize:1,source:1,unsupported:1,native:1,stale:1});
});
it('deduplicates packet IDs and repeat viewers per room, anonymous or anchor entries never welcome',()=>{
 const ledger=new LiveEventLedger(),e=parseLiveEvent(frame(3,{},10000),10000)!;
 expect(ledger.accept(e)).toBe(true);expect(ledger.accept(e)).toBe(false);expect(ledger.welcome(e)).toBe(true);
 expect(ledger.welcome({...e,id:'again',receivedAt:20000})).toBe(false);
 expect(ledger.welcome({...e,roomId:'another-room'})).toBe(true);
 for(const patch of [{type:'chat' as const},{anonymous:true},{isAnchor:true},{userId:''},{ownerId:'viewer'}])expect(welcomeEligible({...e,...patch})).toBe(false);
 expect(ledger.welcome({...e,receivedAt:610001})).toBe(true);
});
it('audio gate fails closed until both native inputs are observed; response.done does not mean playback stopped',()=>{
 const gate=new WelcomeAudioGate();expect(gate.busy(9999999999999)).toBe(true);
 gate.event({type:'input_audio_buffer.speech_started'},100);gate.event({type:'input_audio_buffer.speech_stopped'},200);
 expect(gate.busy(6000)).toBe(true);gate.event({type:'response.created'},300);gate.event({type:'output_audio_buffer.started'},400);gate.event({type:'response.done'},500);
 expect(gate.busy(6000)).toBe(true);gate.event({type:'output_audio_buffer.stopped'},7000);expect(gate.busy(11999)).toBe(true);expect(gate.busy(12000)).toBe(false);
});
class Socket {
 static all:Socket[]=[];static CONNECTING=0;readyState=0;
 onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;onerror?:()=>void;
 constructor(readonly url:string){Socket.all.push(this);}
 close(){this.readyState=3;this.onclose?.();}open(){this.readyState=1;this.onopen?.();}receive(data:string){this.onmessage?.({data});}
}
function ui(openSocket=true){
 vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);
 const send=vi.fn<WelcomeBridge['send']>(()=>true),status=vi.fn<WelcomeBridge['status']>(()=>'ready'),voice={current:{send,status} as WelcomeBridge|null};
 const view=render(<LiveInteractions voice={voice}/>);fireEvent.click(screen.getByRole('button',{name:'互动消息'}));fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));
 const ws=Socket.all[0]!;if(openSocket)act(()=>{ws.open();vi.advanceTimersByTime(500);});return {ws,send,status,voice,view};
}
it('shows ownerless entries immediately, with no old collector or room confirmation, and welcomes only new enabled entries',()=>{
 const f=ui();expect(f.ws.url).toBe('ws://127.0.0.1:18888/');expect(screen.queryByText(/DouyinBarrageGrab/)).toBeNull();
 act(()=>f.ws.receive(frame()));expect(screen.getByText('进入直播间')).toBeTruthy();expect(screen.queryByRole('button',{name:'确认这是我的直播间'})).toBeNull();expect(f.send).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(frame(1,{MsgId:'chat'}));vi.advanceTimersByTime(500);});expect(f.send).not.toHaveBeenCalled();expect(screen.getByText('我来了 <script>alert(1)</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull();
 act(()=>{f.ws.receive(frame(3,{MsgId:'new'}));f.ws.receive(frame(3,{MsgId:'burst',User:{Id:'another'}}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(1);
 act(()=>{f.ws.receive(frame(3,{MsgId:'new'}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(1);
 act(()=>vi.advanceTimersByTime(31000));
 act(()=>{f.ws.receive(frame(3,{RoomId:'another-room',MsgId:'other-room',User:{Id:'third'}}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(2);
});
it('busy pending entry expires instead of playing late; recovery disables welcome; reconnect does not replay or re-enable',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));f.status.mockReturnValue('busy');
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(21000);});f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
 f.status.mockReturnValue('unavailable');act(()=>vi.advanceTimersByTime(500));expect(screen.getByRole('checkbox')).toHaveProperty('checked',false);
 act(()=>f.ws.close());fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));const next=Socket.all[1]!;act(()=>{next.open();next.receive(frame(3,{MsgId:'after-reconnect'}));});expect(screen.getByRole('checkbox')).toHaveProperty('checked',false);expect(f.send).not.toHaveBeenCalled();
 f.view.unmount();expect(next.readyState).toBe(3);
});
it('preserves failure/timeout notices and ignores callbacks from a previous socket after retry',()=>{
 const f=ui(false);act(()=>{f.ws.onerror?.();f.ws.close();});expect(screen.getByText('采集连接失败')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('无法判断具体失败原因');
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));act(()=>vi.advanceTimersByTime(30000));expect(screen.getByRole('alert').textContent).toContain('连接超时');
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));act(()=>{Socket.all[2]!.open();f.ws.onerror?.();f.ws.close();});expect(screen.getByText('本机采集已连接')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});

it('allows enabling while native activity is unknown without sending or replaying unverified entries',()=>{
 const f=ui();f.status.mockReturnValue('unknown');act(()=>vi.advanceTimersByTime(500));
 const toggle=screen.getByRole('checkbox',{name:'入场自动欢迎'});expect(toggle).toHaveProperty('disabled',false);
 fireEvent.click(toggle);expect(toggle).toHaveProperty('checked',true);
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(1000);});expect(f.send).not.toHaveBeenCalled();expect(toggle).toHaveProperty('checked',true);
 expect(screen.getByText('已开启，等待语音状态就绪')).toBeTruthy();
 f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(frame(3,{MsgId:'fresh'}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(1);
 f.status.mockReturnValue('unavailable');act(()=>vi.advanceTimersByTime(500));expect(toggle).toHaveProperty('checked',false);
});
it('discards a pending greeting if native activity becomes unknown',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox'));f.status.mockReturnValue('busy');act(()=>f.ws.receive(frame()));
 f.status.mockReturnValue('unknown');act(()=>vi.advanceTimersByTime(500));f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
});
