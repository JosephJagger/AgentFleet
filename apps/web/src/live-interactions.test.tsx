// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LiveInteractions} from './components/LiveInteractions';
import {parseLiveEvent,LiveCollectorStream,welcomeEligible,LiveEventLedger,localCollectorUrl,type WelcomeBridge} from './lib/live-interactions';
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
it('shows delayed messages without welcoming old entries; rejects invalid or excessive timestamps',()=>{
 const delayed=parseLiveEvent(frame(3,{},10000),140001)!;
 expect(delayed.type).toBe('enter');expect(welcomeEligible(delayed,140001)).toBe(false);
 expect(parseLiveEvent(frame(3,{},10000),86410001)).toBeNull();
 expect(parseLiveEvent(frame(3,{},60001),30000)).toBeNull();
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
it('deduplicates packets while allowing distinct new entries by the same viewer',()=>{
 const ledger=new LiveEventLedger(),e=parseLiveEvent(frame(3,{},10000),10000)!;
 expect(ledger.accept(e)).toBe(true);expect(ledger.accept(e)).toBe(false);expect(ledger.welcome(e,10000)).toBe(true);
 const returning={...e,id:'again',receivedAt:13000};expect(ledger.accept(returning)).toBe(true);expect(ledger.welcome(returning,13000)).toBe(true);
 for(const patch of [{type:'chat' as const},{anonymous:true},{isAnchor:true},{userId:''},{ownerId:'viewer'}])expect(welcomeEligible({...e,...patch},10000)).toBe(false);
});
it('displays supported interactions without treating any of them as entries',()=>{
 for(const [type,method,interaction] of [[2,'WebcastLikeMessage','like'],[4,'WebcastSocialMessage','follow'],[5,'WebcastGiftMessage','gift'],[7,'WebcastFansclubMessage','fansclub'],[8,'WebcastSocialMessage','share']] as const){
  const event=parseLiveEvent(frame(type,{NativeMethod:method,Content:'',GiftName:'玫瑰',GiftCount:3}))!;
  expect(event).toMatchObject({type:'interaction',interaction});expect(welcomeEligible(event)).toBe(false);
 }
 expect(parseLiveEvent(frame(5,{NativeMethod:'WebcastGiftMessage',Content:'',GiftName:'玫瑰',GiftCount:3}))).toMatchObject({giftName:'玫瑰',count:3});
});
class Socket {
 static all:Socket[]=[];static CONNECTING=0;readyState=0;
 onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;onerror?:()=>void;
 constructor(readonly url:string){Socket.all.push(this);}
 close(){this.readyState=3;this.onclose?.();}open(){this.readyState=1;this.onopen?.();}receive(data:string){this.onmessage?.({data});}
}
function ui(openSocket=true){
 vi.useFakeTimers();Socket.all=[];vi.stubGlobal('WebSocket',Socket);
 const status=vi.fn<WelcomeBridge['status']>(()=>'ready'),voice={current:null as WelcomeBridge|null};
 const send=vi.fn<WelcomeBridge['send']>(event=>{voice.current!.receipt={requestId:event.id,status:'accepted'};return true;});voice.current={send,status};
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
 act(()=>{f.ws.receive(frame(3,{RoomId:'another-room',MsgId:'other-room',User:{Id:'third'}}));vi.advanceTimersByTime(500);});expect(f.send).toHaveBeenCalledTimes(3);
});
it('keeps greetings through a brief voice recovery, expires stale entries and stops on explicit disconnect',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));f.status.mockReturnValue('busy');
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(121000);});f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).not.toHaveBeenCalled();
 f.status.mockReturnValue('unknown');act(()=>{f.ws.receive(frame(3,{MsgId:'recovery'}));vi.advanceTimersByTime(500);});
 expect(screen.getByRole('checkbox')).toHaveProperty('checked',true);
 f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'停止接收'}));fireEvent.click(screen.getByRole('button',{name:'连接采集器'}));const next=Socket.all[1]!;
 act(()=>{next.open();next.receive(frame(3,{MsgId:'after-reconnect'}));vi.advanceTimersByTime(500);});expect(screen.getByRole('checkbox')).toHaveProperty('checked',false);expect(f.send).toHaveBeenCalledTimes(1);
 f.view.unmount();expect(next.readyState).toBe(3);
});
it('preserves failure/timeout notices and ignores callbacks from a previous socket after retry',()=>{
 const f=ui(false);act(()=>{f.ws.onerror?.();f.ws.close();});expect(screen.getByText('采集连接失败')).toBeTruthy();expect(screen.getByRole('alert').textContent).toContain('无法判断具体失败原因');
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));act(()=>vi.advanceTimersByTime(30000));expect(screen.getByRole('alert').textContent).toContain('连接超时');
 fireEvent.click(screen.getByRole('button',{name:'重试连接'}));act(()=>{Socket.all[2]!.open();f.ws.onerror?.();f.ws.close();});expect(screen.getByText('本机采集已连接')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});

it('can be enabled before voice is ready and welcomes queued entries once connected',()=>{
 const f=ui();f.status.mockReturnValue('unavailable');act(()=>vi.advanceTimersByTime(500));
 const toggle=screen.getByRole('checkbox',{name:'入场自动欢迎'});expect(toggle).toHaveProperty('disabled',false);fireEvent.click(toggle);
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(1000);});expect(f.send).not.toHaveBeenCalled();expect(toggle).toHaveProperty('checked',true);
 expect(screen.getByText('已开启，等待语音连接就绪')).toBeTruthy();
 f.status.mockReturnValue('ready');act(()=>vi.advanceTimersByTime(500));expect(f.send).toHaveBeenCalledTimes(1);
});
it('queues entries during the short cooldown and welcomes returning viewers',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox'));
 act(()=>{f.ws.receive(frame(3,{MsgId:'first'}));f.ws.receive(frame(3,{MsgId:'second'}));f.ws.receive(frame(3,{MsgId:'third'}));vi.advanceTimersByTime(500);});
 expect(f.send).toHaveBeenCalledTimes(1);act(()=>vi.advanceTimersByTime(3000));expect(f.send).toHaveBeenCalledTimes(2);
 act(()=>vi.advanceTimersByTime(3000));expect(f.send).toHaveBeenCalledTimes(3);
 act(()=>{f.ws.receive(frame(3,{MsgId:'third'}));vi.advanceTimersByTime(3000);});expect(f.send).toHaveBeenCalledTimes(3);
});
it('retries only explicit temporary refusals, never uncertain deliveries',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox'));
 f.send.mockImplementationOnce(event=>{f.voice.current!.receipt={requestId:event.id,status:'skipped',reason:'tool_active'};return true;});
 act(()=>{f.ws.receive(frame());vi.advanceTimersByTime(1000);});expect(f.send).toHaveBeenCalledTimes(1);
 act(()=>vi.advanceTimersByTime(3000));expect(f.send).toHaveBeenCalledTimes(2);
 f.send.mockImplementationOnce(event=>{f.voice.current!.receipt={requestId:event.id,status:'unknown'};return true;});
 act(()=>{f.ws.receive(frame(3,{MsgId:'uncertain'}));vi.advanceTimersByTime(10000);});expect(f.send).toHaveBeenCalledTimes(3);
 act(()=>vi.advanceTimersByTime(120000));expect(f.send).toHaveBeenCalledTimes(3);
});
it('filters messages, shows timestamps and restores trigger focus without disconnecting',()=>{
 const f=ui();act(()=>{f.ws.receive(frame(1,{MsgId:'chat'}));f.ws.receive(frame());f.ws.receive(frame(5,{MsgId:'gift',NativeMethod:'WebcastGiftMessage',Content:'',GiftName:'玫瑰',GiftCount:3}));});
 const region=screen.getByRole('region',{name:'收到的互动消息'});
 expect(region.querySelectorAll('time')).toHaveLength(3);expect(within(region).getByText('送出 玫瑰 × 3')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'聊天 1'}));expect(within(region).queryByText('进入直播间')).toBeNull();expect(within(region).getByText('我来了 <script>alert(1)</script>')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'互动 1'}));expect(within(region).getByText('送出 玫瑰 × 3')).toBeTruthy();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(document.activeElement).toBe(screen.getByRole('button',{name:'互动消息'}));expect(f.ws.readyState).toBe(1);
});
it('keeps a bounded view and does not jump down while reading earlier messages',()=>{
 const f=ui();const region=screen.getByRole('region',{name:'收到的互动消息'});
 Object.defineProperties(region,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollTop:{configurable:true,writable:true,value:100}});
 fireEvent.scroll(region);act(()=>{for(let i=0;i<110;i++)f.ws.receive(frame(1,{MsgId:`chat-${i}`}));});
 expect(region.querySelectorAll('article')).toHaveLength(100);expect(region.scrollTop).toBe(100);
 fireEvent.click(screen.getByRole('button',{name:'跟随最新'}));expect(region.scrollTop).toBe(1000);
});
it('shows the server rejection reason instead of falsely claiming the coordinator is busy',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox'));f.voice.current!.receipt={requestId:'rejected',status:'skipped',reason:'event_time'};
 act(()=>vi.advanceTimersByTime(500));expect(screen.getByText('事件时间超出允许范围，请校准直播电脑时间')).toBeTruthy();expect(screen.queryByText('总控繁忙，本次已跳过')).toBeNull();
});

it('continues receiving and welcoming while the message popup is closed and the page is hidden',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox'));
 const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
 fireEvent.click(screen.getByRole('button',{name:'收起互动消息'}));
 act(()=>{document.dispatchEvent(new Event('visibilitychange'));f.ws.receive(frame(1,{MsgId:'background-chat',Content:'后台聊天仍在接收'}));f.ws.receive(frame(3,{MsgId:'background-entry'}));vi.advanceTimersByTime(500);});
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.ws.readyState).toBe(1);
 fireEvent.click(screen.getByRole('button',{name:'互动消息'}));expect(screen.getByText('后台聊天仍在接收')).toBeTruthy();visibility.mockRestore();
});

it('accepts Companion 0.3.0 native chat with its real source and transport, without welcome eligibility',()=>{
 const event=parseLiveEvent(frame(1,{CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message',Owner:null,User:{Id:'',Nickname:'桥接观众'},Content:'桥接聊天'}))!;
 expect(event).toMatchObject({type:'chat',collector:'companion-memory-bridge',collectorTransport:'native-publish-message',content:'桥接聊天'});
 expect(welcomeEligible(event)).toBe(false);
 expect(welcomeEligible({...event,type:'enter',userId:'viewer'})).toBe(false);
 for(const patch of [{CollectorTransport:undefined},{CollectorTransport:'websocket'},{NativeMethod:'WebcastMemberMessage'},{ObservedAt:'bad'},{MsgId:''},{RoomId:''},{Content:null}])expect(parseLiveEvent(frame(1,{CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message',...patch}))).toBeNull();
 for(const type of [2,3,4,5,7,8])expect(parseLiveEvent(frame(type,{CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message'}))).toBeNull();
 expect(parseLiveEvent(frame(1,{CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message'},Date.now(),'HomeDouyinBrowser'))).toBeNull();
});
it('accepts explicit browser chat and interactions but rejects cross-source and entry packets',()=>{
 for(const transport of ['websocket','http-fetch']) {
  for(const [type,method] of [[1,'WebcastChatMessage'],[2,'WebcastLikeMessage'],[4,'WebcastSocialMessage'],[5,'WebcastGiftMessage'],[7,'WebcastFansclubMessage'],[8,'WebcastSocialMessage']] as const) {
   const packet=frame(type,{CollectorSource:'douyin-browser-network',CollectorTransport:transport,NativeMethod:method},Date.now(),'HomeDouyinBrowser');
   const e=parseLiveEvent(packet)!;expect(e.collector).toBe('douyin-browser-network');expect(welcomeEligible(e)).toBe(false);
  }
 }
 for(const patch of [{CollectorTransport:undefined},{CollectorTransport:'native-publish-message'},{CollectorSource:'companion-log'},{CollectorSource:'companion-memory-bridge'}])expect(parseLiveEvent(frame(1,{CollectorSource:'douyin-browser-network',CollectorTransport:'websocket',...patch},Date.now(),'HomeDouyinBrowser'))).toBeNull();
 expect(parseLiveEvent(frame(3,{CollectorSource:'douyin-browser-network',CollectorTransport:'websocket'},Date.now(),'HomeDouyinBrowser'))).toBeNull();
 expect(parseLiveEvent(frame(1,{CollectorSource:'douyin-browser-network',CollectorTransport:'websocket'}))).toBeNull();
 expect(parseLiveEvent(frame(1,{CollectorSource:'unknown'}))).toBeNull();
});
it('deduplicates the same chat across sources while retaining source validation diagnostics',()=>{
 const stream=new LiveCollectorStream(),ledger=new LiveEventLedger();
 const log=stream.read(frame(1)).event!;
 const bridge=stream.read(frame(1,{CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message'})).event!;
 const browser=stream.read(frame(1,{CollectorSource:'douyin-browser-network',CollectorTransport:'http-fetch'},Date.now(),'HomeDouyinBrowser')).event!;
 expect(ledger.accept(log)).toBe(true);expect(ledger.accept(bridge)).toBe(false);expect(ledger.accept(browser)).toBe(false);
 expect(stream.diagnostics).toMatchObject({chat:3,rejected:0});
});
it('renders native bridge chat in the actual message panel and preserves log-only welcomes',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 act(()=>{f.ws.receive(frame(1,{MsgId:'native-chat',CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message',Content:'新桥接消息'}));vi.advanceTimersByTime(500);});
 expect(screen.getByText('新桥接消息')).toBeTruthy();expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(frame(3,{MsgId:'forged-entry',CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message'}));vi.advanceTimersByTime(500);});
 expect(f.send).not.toHaveBeenCalled();
 act(()=>{f.ws.receive(frame(3,{MsgId:'real-log-entry'}));vi.advanceTimersByTime(500);});
 expect(f.send).toHaveBeenCalledTimes(1);expect(f.send.mock.calls[0][0].collector).toBe('companion-log');
});

it('keeps three rapid chats from one viewer, including identical text and adjacent 64-bit message IDs',()=>{
 const f=ui();fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 const packets=['9223372036854775801','9223372036854775802','9223372036854775803'].map(MsgId=>{
  const pack=JSON.parse(frame(1,{MsgId,CollectorSource:'companion-memory-bridge',CollectorTransport:'native-publish-message',User:{Id:'one-viewer',Nickname:'合成连续发言者'},Content:'同一句合成消息'}));
  // Exercise unquoted 64-bit IDs without losing their final digits.
  pack.Data=pack.Data.replace('"'+MsgId+'"',MsgId);return JSON.stringify(pack);
 });
 act(()=>{for(const packet of packets)f.ws.receive(packet);vi.advanceTimersByTime(500);});
 expect(screen.getAllByText('同一句合成消息')).toHaveLength(3);
 expect(screen.getAllByText('合成连续发言者')).toHaveLength(3);
 expect(f.send).not.toHaveBeenCalled();
 act(()=>{for(const packet of packets)f.ws.receive(packet);vi.advanceTimersByTime(500);});
 expect(screen.getAllByText('同一句合成消息')).toHaveLength(3);
});

it('edits and persists greetings only on Save, uses saved text for the next real entry and keeps drafts inactive',()=>{
 const key='agentfleet.live-interactions.welcome-text';localStorage.removeItem(key);
 const f=ui();fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));
 fireEvent.click(screen.getByRole('button',{name:'编辑欢迎语'}));
 fireEvent.change(screen.getByRole('textbox',{name:'欢迎语内容'}),{target:{value:'欢迎来到测试直播间'}});
 act(()=>{f.ws.receive(frame(3,{MsgId:'before-save'}));vi.advanceTimersByTime(500);});
 expect(f.send.mock.calls[0][1]).toBe('嗨，你好，欢迎光临');expect(localStorage.getItem(key)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'保存欢迎语'}));
 expect(localStorage.getItem(key)).toBe('欢迎来到测试直播间');
 act(()=>{vi.advanceTimersByTime(3500);f.ws.receive(frame(3,{MsgId:'after-save'}));vi.advanceTimersByTime(500);});
 expect(f.send.mock.calls[1][1]).toBe('欢迎来到测试直播间');
 act(()=>{f.ws.receive(frame(3,{MsgId:'after-save'}));f.ws.receive(frame(1,{MsgId:'chat-not-entry'}));vi.advanceTimersByTime(3500);});expect(f.send).toHaveBeenCalledTimes(2);
 f.view.unmount();const next=ui();expect(screen.getByText('欢迎来到测试直播间')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'编辑欢迎语'}));fireEvent.change(screen.getByRole('textbox',{name:'欢迎语内容'}),{target:{value:'未保存'}});fireEvent.click(screen.getByRole('button',{name:'取消'}));
 expect(screen.getByText('欢迎来到测试直播间')).toBeTruthy();next.view.unmount();localStorage.removeItem(key);
});
it('invalid or failed saves do not replace the active welcome; unavailable storage falls back to the default',()=>{
 const key='agentfleet.live-interactions.welcome-text';localStorage.removeItem(key);const f=ui();
 fireEvent.click(screen.getByRole('button',{name:'编辑欢迎语'}));fireEvent.change(screen.getByRole('textbox',{name:'欢迎语内容'}),{target:{value:'  '}});fireEvent.click(screen.getByRole('button',{name:'保存欢迎语'}));
 expect(screen.getByText('请输入 1–200 个字符的欢迎语')).toBeTruthy();expect(localStorage.getItem(key)).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'欢迎语内容'}),{target:{value:'新的欢迎'}});
 const fail=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
 fireEvent.click(screen.getByRole('button',{name:'保存欢迎语'}));expect(screen.getByText('保存失败，仍使用原欢迎语；请检查浏览器存储设置')).toBeTruthy();fail.mockRestore();
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));act(()=>{f.ws.receive(frame(3));vi.advanceTimersByTime(500);});expect(f.send.mock.calls[0][1]).toBe('嗨，你好，欢迎光临');
 f.view.unmount();localStorage.setItem(key,'');const next=ui();expect(screen.getByText('嗨，你好，欢迎光临')).toBeTruthy();next.view.unmount();localStorage.removeItem(key);
});

it('inserts username at the caret or selection and saves only the template, not viewer names',()=>{
 const key='agentfleet.live-interactions.welcome-text';localStorage.removeItem(key);const f=ui();
 fireEvent.click(screen.getByRole('button',{name:'编辑欢迎语'}));
 const editor=screen.getByRole('textbox',{name:'欢迎语内容'}) as HTMLTextAreaElement;
 fireEvent.change(editor,{target:{value:'欢迎来到直播间'}});editor.setSelectionRange(2,2);
 fireEvent.click(screen.getByRole('button',{name:'插入 {用户名}'}));expect(editor.value).toBe('欢迎{用户名}来到直播间');
 editor.setSelectionRange(0,2);fireEvent.click(screen.getByRole('button',{name:'插入 {用户名}'}));expect(editor.value).toBe('{用户名}{用户名}来到直播间');
 fireEvent.click(screen.getByRole('button',{name:'保存欢迎语'}));expect(localStorage.getItem(key)).toBe('{用户名}{用户名}来到直播间');
 fireEvent.click(screen.getByRole('checkbox',{name:'入场自动欢迎'}));act(()=>{f.ws.receive(frame(3,{User:{Id:'fixture-viewer',Nickname:'合成访客'}}));vi.advanceTimersByTime(500);});
 expect(f.send.mock.calls[0][0].name).toBe('合成访客');expect(f.send.mock.calls[0][1]).toBe('{用户名}{用户名}来到直播间');expect(localStorage.getItem(key)).not.toContain('合成访客');
 f.view.unmount();localStorage.removeItem(key);
});
