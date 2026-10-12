// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LiveInteractions} from './components/LiveInteractions';
import {parseLiveEvent,LiveCollectorStream,LiveRoomMarker,welcomeEligible,LiveEventLedger,WelcomeAudioGate,localCollectorUrl,type WelcomeBridge} from './lib/live-interactions';
const frame=(type=3,room='room',id='event',process='直播伴侣')=>JSON.stringify({Type:type,ProcessName:process,Data:JSON.stringify({RoomId:room,MsgId:id,Owner:{UserId:'owner',Nickname:'Fixture owner'},User:{Id:'viewer',Nickname:'Fixture viewer'},Content:'我来了 <script>alert(1)</script>'})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('distinguishes chat from real member packets and rejects unrelated processes, statistics and missing ownership',()=>{
 expect(parseLiveEvent(frame(1))?.type).toBe('chat');expect(parseLiveEvent(frame())?.type).toBe('enter');
 expect(parseLiveEvent(frame(6))?.type).toBe('room');expect(parseLiveEvent(frame(3,'room','event','chrome'))).toBeNull();
 expect(parseLiveEvent(JSON.stringify({Type:3,ProcessName:'直播伴侣',Data:{RoomId:'room',MsgId:1,User:{Id:2}}}))?.ownerId).toBe('');
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
const packet=(type:number,data:Record<string,unknown>,process='直播伴侣')=>JSON.stringify({Type:type,ProcessName:process,Data:data});
it('reports silence separately from rejected packets and treats stats as metadata, never entry',()=>{
 const stream=new LiveCollectorStream();expect(stream.diagnostics.packets).toBe(0);
 expect(stream.read('bad').reason).toBe('format');expect(stream.read(new ArrayBuffer(2)).reason).toBe('binary');
 expect(stream.read(frame(3,'room','event','chrome')).reason).toBe('source');
 expect(stream.read(frame(5)).reason).toBe('unsupported');
 expect(stream.read(packet(1,{MsgId:'a',Content:'hello'})).reason).toBe('room');
 expect(stream.read(packet(1,{RoomId:'r',Content:'hello'})).reason).toBe('message');
 expect(stream.read('a'.repeat(65537)).reason).toBe('oversize');
 expect(stream.read(frame(6)).event?.type).toBe('room');
 expect(stream.diagnostics).toMatchObject({packets:8,rejected:7,metadata:1,chat:0,enter:0});
});
it('receives ownerless chat and entry, enriches only from the same room and resets at stream boundaries',()=>{
 const stream=new LiveCollectorStream(),data={RoomId:'r',MsgId:'m',User:{Id:'viewer'},Content:'hello'};
 const raw=packet(1,data);expect(stream.read(raw).event).toMatchObject({type:'chat',ownerId:'',content:'hello'});
 const entry=stream.read(packet(3,data)).event!;expect(entry.type).toBe('enter');expect(welcomeEligible(entry)).toBe(false);
 stream.read(packet(6,{RoomId:'other',Owner:{UserId:'other-owner'}}));
 expect(stream.read(raw).event?.ownerId).toBe('');
 stream.read(packet(101,{RoomId:'r',Data:{Owner:{UserId:'owner',Nickname:'Fixture'},Title:'Fixture room'}}));
 expect(stream.read(raw).event).toMatchObject({ownerId:'owner',ownerName:'Fixture',roomTitle:'Fixture room'});
 expect(welcomeEligible(stream.read(packet(3,data)).event!)).toBe(true);
 stream.read(packet(102,{RoomId:'r'}));expect(stream.read(raw).event?.ownerId).toBe('');
 stream.read(packet(6,{RoomId:'r',Owner:{UserId:'owner'}}));
 stream.read(packet(101,{RoomId:'r'}));expect(stream.read(raw).event?.ownerId).toBe('');
 expect(new LiveCollectorStream().read(raw).event?.ownerId).toBe('');
});
it('anonymous chat remains readable, but anonymous/anchor/missing-viewer entries cannot request welcomes',()=>{
 const data={RoomId:'r',MsgId:'m',Owner:{UserId:'owner'},User:{Id:'v'},Content:'hello'};
 expect(parseLiveEvent(packet(1,{...data,IsAnonymous:true}))?.content).toBe('hello');
 for(const patch of [{IsAnonymous:true},{User:null},{User:{Id:'owner'}},{User:{Id:'v',IsAnchor:true}}]){
  const e=parseLiveEvent(packet(3,{...data,...patch}))!;expect(e.type).toBe('enter');expect(welcomeEligible(e)).toBe(false);
 }
});
it('room marker requires exact new chat, expires, and cannot use entry text as proof',()=>{
 const marker=new LiveRoomMarker(),text=marker.create(100);
 const event={...parseLiveEvent(frame(1))!,content:text};
 marker.observe({...event,type:'enter'},101);expect(marker.matches('room',101)).toBe(false);
 marker.observe({...event,content:text+' x'},102);expect(marker.matches('room',102)).toBe(false);
 marker.observe(event,103);expect(marker.matches('room',103)).toBe(true);expect(marker.matches('other',103)).toBe(false);
 expect(marker.matches('room',300101)).toBe(false);marker.create(300102);marker.observe(event,300103);expect(marker.matches('room',300103)).toBe(false);
 marker.clear();expect(marker.matches('room',300103)).toBe(false);
});
it('shows ownerless room, confirms by a real matching chat packet, and keeps welcome disabled until owner reconfirmation',()=>{
 const f=ui(),data={RoomId:'r',MsgId:'first',User:{Id:'v'},Content:'Fixture chat'};
 act(()=>f.ws.receive(packet(1,data)));
 expect(screen.getByRole('button',{name:'确认这是我的直播间'})).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('button',{name:'生成校验文字'}));
 const text=(screen.getByLabelText('校验文字（五分钟有效）') as HTMLInputElement).value;
 act(()=>f.ws.receive(packet(1,{...data,MsgId:'marker',Content:text})));
 fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));
 expect(screen.getByText('Fixture chat')).toBeTruthy();expect(screen.getByRole('checkbox',{name:'入场自动欢迎'})).toHaveProperty('disabled',true);
 act(()=>{f.ws.receive(packet(3,{...data,MsgId:'enter'}));vi.advanceTimersByTime(500);});expect(f.send).not.toHaveBeenCalled();
 act(()=>f.ws.receive(packet(6,{RoomId:'r',Owner:{UserId:'owner'}})));
 expect(screen.queryByRole('checkbox')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(packet(3,{...data,MsgId:'fresh',User:{Id:'new'}}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(1);
});
it('ownerless end removes the candidate and selection; reconnect never retains room confirmation or metadata',()=>{
 const f=ui();act(()=>f.ws.receive(frame()));fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));
 act(()=>f.ws.receive(packet(102,{RoomId:'room'})));expect(screen.queryByRole('checkbox')).toBeNull();
 expect(screen.queryByRole('button',{name:'确认这是我的直播间'})).toBeNull();
 act(()=>f.ws.close());fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));const next=Socket.all[1]!;
 act(()=>{next.open();next.receive(packet(3,{RoomId:'room',MsgId:'new',User:{Id:'v'}}));});
 expect(screen.getByRole('button',{name:'确认这是我的直播间'})).toHaveProperty('disabled',true);expect(f.send).not.toHaveBeenCalled();
});
it('bounds metadata cache and never merges conflicting broadcaster identity',()=>{
 const stream=new LiveCollectorStream();
 for(let i=0;i<6;i++)stream.read(packet(6,{RoomId:`r${i}`,Owner:{UserId:`owner${i}`,Nickname:'Old name'}}));
 const data={RoomId:'r0',MsgId:'chat',Content:'hello'};
 expect(stream.read(packet(1,data)).event?.ownerId).toBe('');
 expect(stream.read(packet(6,{RoomId:'r5',Owner:{UserId:'changed'}})).event).toMatchObject({ownerId:'changed',ownerName:''});
});
it('metadata loss within a confirmed room does not stop reception or replay old entry welcomes',()=>{
 const f=ui();act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(500);});fireEvent.click(screen.getByRole('button',{name:'确认这是我的直播间'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 const data={RoomId:'room',MsgId:'second',User:{Id:'viewer2'},Content:'Live chat'};
 act(()=>{f.ws.receive(packet(1,data));vi.advanceTimersByTime(500);});expect(screen.getByText('Live chat')).toBeTruthy();expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(packet(3,{...data,MsgId:'fresh-entry'}));f.ws.receive(packet(3,{...data,MsgId:'fresh-entry'}));vi.advanceTimersByTime(500);});
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.send.mock.calls[0]?.length).toBe(1);
 act(()=>f.ws.close());expect(screen.queryByText('Live chat')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();
});
