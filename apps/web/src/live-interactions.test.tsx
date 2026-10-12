// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LiveInteractions} from './components/LiveInteractions';
import {parseLiveEvent,LiveEventLedger,WelcomeAudioGate,localCollectorUrl,type WelcomeBridge} from './lib/live-interactions';
const frame=(type=3,room='room',id='event',process='直播伴侣')=>JSON.stringify({Type:type,ProcessName:process,Data:JSON.stringify({RoomId:room,MsgId:id,Owner:{UserId:'owner',Nickname:'Fixture owner'},User:{Id:'viewer',Nickname:'Fixture viewer'},Content:'我来了 <script>alert(1)</script>'})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('distinguishes chat from real member packets and rejects unrelated processes, statistics and missing ownership',()=>{
 expect(parseLiveEvent(frame(1))?.type).toBe('chat');expect(parseLiveEvent(frame())?.type).toBe('enter');
 expect(parseLiveEvent(frame(6))).toBeNull();expect(parseLiveEvent(frame(3,'room','event','chrome'))).toBeNull();
 expect(parseLiveEvent(JSON.stringify({Type:3,ProcessName:'直播伴侣',Data:{RoomId:'room',MsgId:1,User:{Id:2}}}))).toBeNull();
 expect(parseLiveEvent('bad json')).toBeNull();expect(()=>localCollectorUrl('8888/path')).toThrow();expect(localCollectorUrl('8888')).toBe('ws://127.0.0.1:8888/');
});
it('preserves native 64-bit IDs, escaped text and data strings without rounding',()=>{
 const data='{"RoomId":"room","MsgId":9223372036854775801,"User":{"Id":9223372036854775802},"Owner":{"UserId":"owner"},"Content":"number 9223372036854775803"}';
 const event=parseLiveEvent(JSON.stringify({Type:1,ProcessName:'直播伴侣',Data:data}));
 expect(event?.id).toBe('9223372036854775801');expect(event?.userId).toBe('9223372036854775802');expect(event?.content).toBe('number 9223372036854775803');
});
it('deduplicates member packets and repeat viewers without treating chat as entry',()=>{
 const ledger=new LiveEventLedger(),event=parseLiveEvent(frame(),10000)!;
 expect(ledger.accept(event)).toBe(true);expect(ledger.accept(event)).toBe(false);
 expect(ledger.welcome(event)).toBe(true);expect(ledger.welcome({...event,id:'again',receivedAt:20000})).toBe(false);
 expect(ledger.welcome({...event,type:'chat',userId:'new'})).toBe(false);
 expect(ledger.welcome({...event,id:'again',receivedAt:610001})).toBe(true);
});
it('audio gate fails closed without input/output evidence; response.done is not playback.done',()=>{
 const gate=new WelcomeAudioGate();expect(gate.busy(9999999999999)).toBe(true);
 gate.event({type:'input_audio_buffer.speech_started'},100);gate.event({type:'input_audio_buffer.speech_stopped'},200);
 expect(gate.busy(6000)).toBe(true);
 gate.event({type:'response.created'},300);gate.event({type:'output_audio_buffer.started'},400);gate.event({type:'response.done'},500);
 expect(gate.busy(6000)).toBe(true);gate.event({type:'output_audio_buffer.stopped'},7000);
 expect(gate.busy(11999)).toBe(true);expect(gate.busy(12000)).toBe(false);
 gate.event({type:'input_audio_buffer.speech_started'},12001);expect(gate.busy(20000)).toBe(true);
});
class Socket {
 static all:Socket[]=[];static CONNECTING=0;readyState=0;
 onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;onerror?:()=>void;
 constructor(readonly url:string){Socket.all.push(this);}
 close(){this.readyState=3;this.onclose?.();}
 open(){this.readyState=1;this.onopen?.();}
 receive(data:string){this.onmessage?.({data});}
}
function ui(){
 vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);
 const send=vi.fn(()=>true),status=vi.fn<WelcomeBridge['status']>(()=>'ready');
 const voice={current:{send,status} as WelcomeBridge|null};
 const view=render(<LiveInteractions voice={voice}/>);fireEvent.click(screen.getByRole('button',{name:'互动消息'}));fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));
 const ws=Socket.all[0]!;act(()=>ws.open());return {ws,send,status,voice,view};
}
it('requires own-room confirmation and explicit enable, merges entries, clears on room change and never speaks chat',()=>{
 const f=ui();expect(f.ws.url).toBe('ws://127.0.0.1:8888/');
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(1000);});expect(f.send).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 act(()=>{f.ws.receive(frame(1,'room','chat'));vi.advanceTimersByTime(1000);});expect(f.send).not.toHaveBeenCalled();
 expect(screen.getByText('我来了 <script>alert(1)</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull();
 act(()=>{f.ws.receive(frame(3,'room','enter1'));f.ws.receive(frame(3,'room','enter2'));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(1);
 act(()=>{f.ws.receive(frame(3,'other-room','entry3'));vi.advanceTimersByTime(60000);});expect(f.send).toHaveBeenCalledTimes(1);expect(screen.queryByRole('checkbox')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'停止接收'}));expect(f.ws.readyState).toBe(3);
});
it('busy voice expires instead of playing late; disconnect/unmount stop the local stream only',()=>{
 const f=ui();act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(500);});fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 f.status.mockReturnValue('busy');act(()=>{f.ws.receive(frame(3,'room','entry2'));vi.advanceTimersByTime(21000);});
 f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(1000));expect(f.send).not.toHaveBeenCalled();
 f.view.unmount();expect(f.ws.readyState).toBe(3);
});
it('preserves connection failures after close and allows a successful retry without stale socket interference',()=>{
 vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);
 render(<LiveInteractions voice={{current:null}}/>);
 fireEvent.click(screen.getByRole('button',{name:'互动消息'}));
 fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));
 expect(screen.getByRole('button',{name:'正在连接…'})).toHaveProperty('disabled',true);
 const first=Socket.all[0]!;act(()=>{first.onerror?.();first.close();});
 expect(screen.getByText('采集连接失败')).toBeTruthy();
 expect(screen.getByRole('alert').textContent).toContain('网页无法判断具体失败原因');
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));
 const next=Socket.all[1]!;act(()=>{next.open();first.onerror?.();first.close();});
 expect(screen.getByText('本机采集已连接')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 act(()=>next.close());expect(screen.getByRole('alert').textContent).toContain('已断开');
});
it('keeps timeout evidence through close and validates ports before opening a socket',()=>{
 vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);
 render(<LiveInteractions voice={{current:null}}/>);fireEvent.click(screen.getByRole('button',{name:'互动消息'}));
 fireEvent.change(screen.getByLabelText('本机采集端口'),{target:{value:'0'}});
 fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));
 expect(Socket.all).toHaveLength(0);expect(screen.getByRole('alert').textContent).toContain('1024–65535');
 fireEvent.change(screen.getByLabelText('本机采集端口'),{target:{value:'8888'}});
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));act(()=>vi.advanceTimersByTime(30000));
 expect(screen.getByText('采集连接失败')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('连接超时');
 expect(Socket.all[0]!.readyState).toBe(3);
 fireEvent.click(screen.getByRole('button',{name:'停止接收'}));expect(screen.getByText('采集未连接')).toBeTruthy();
});
