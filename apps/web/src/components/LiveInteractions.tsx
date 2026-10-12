import {useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {MessagesSquare,X} from 'lucide-react';
import {t} from '../i18n';
import {displayName} from '../lib/display-name';
import {useDraggablePanel} from '../lib/use-draggable-panel';
import {LiveEventLedger,LiveCollectorStream,emptyCollectorDiagnostics,localCollectorUrl,type LiveEvent,type WelcomeBridge} from '../lib/live-interactions';

export function LiveInteractions({voice,supported=true}:{voice:RefObject<WelcomeBridge|null>;supported?:boolean}) {
  const [open,setOpen]=useState(false),[port,setPort]=useState('18888');

  const [diagnostics,setDiagnostics]=useState(emptyCollectorDiagnostics);
  const stream=useRef(new LiveCollectorStream());
  const connectionTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [connection,setConnection]=useState<'off'|'connecting'|'open'|'error'>('off');
  const [notice,setNotice]=useState(''),[enabled,setEnabled]=useState(false),[voiceStatus,setVoiceStatus]=useState('unavailable');
  const [events,setEvents]=useState<LiveEvent[]>([]);
  const messages=useRef<HTMLDivElement>(null);
  const [follow,setFollow]=useState(true);
  useEffect(()=>{if(open&&follow&&messages.current)messages.current.scrollTop=messages.current.scrollHeight;},[events,open,follow]);
  const [lastAt,setLastAt]=useState(0),[welcomeState,setWelcomeState]=useState('未开启');
  const panel=useRef<HTMLElement>(null),dragging=useDraggablePanel(panel,open);
  const socket=useRef<WebSocket|null>(null),welcoming=useRef(false);
  const pending=useRef<LiveEvent|null>(null),cooldown=useRef(0),ledger=useRef(new LiveEventLedger()),lastReceipt=useRef('');
  const resetWelcome=()=>{welcoming.current=false;pending.current=null;setEnabled(false);setWelcomeState('未开启');};
  const stop=()=>{setEvents([]);clearTimeout(connectionTimer.current);const previous=socket.current;socket.current=null;previous?.close();resetWelcome();setConnection('off');setNotice('');};
  useEffect(()=>{const logout=()=>stop();window.addEventListener('agentfleet:logout',logout);window.addEventListener('pagehide',logout);return()=>{window.removeEventListener('agentfleet:logout',logout);window.removeEventListener('pagehide',logout);const previous=socket.current;socket.current=null;previous?.close();pending.current=null;clearTimeout(connectionTimer.current);};},[]);
  useEffect(()=>{if(!open)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[open]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      const bridge=voice.current,status=!supported?'unavailable':bridge?.status()??'unavailable';setVoiceStatus(status);
      const receipt=bridge?.receipt;
      if(receipt&&`${receipt.requestId}:${receipt.status}`!==lastReceipt.current){lastReceipt.current=`${receipt.requestId}:${receipt.status}`;setWelcomeState(receipt.status==='accepted'?'已送达总控，未确认实际播音':receipt.status==='requested'?'已请求欢迎，等待回执':receipt.status==='skipped'?'总控繁忙，本次已跳过':'送达未确认，不重试');}
      if(!welcoming.current)return;
      if(status==='unavailable'){resetWelcome();return;}
      if(status==='unknown'){pending.current=null;setWelcomeState('已开启，等待语音状态就绪');return;}
      if(!pending.current)setWelcomeState(previous=>previous==='已开启，等待语音状态就绪'?'等待新的入场事件':previous);
      const entry=pending.current;if(!entry)return;
      if(Date.now()-entry.receivedAt>20000){pending.current=null;setWelcomeState('等待超时，已跳过');return;}
      if(status!=='ready')return;
      // One attempt only. Never replay uncertain outcomes or build a growing voice queue.
      if(bridge?.send(entry)){pending.current=null;cooldown.current=Date.now()+30000;setWelcomeState('已请求欢迎，等待回执');}
    },500);
    return()=>clearInterval(timer);
  },[voice,supported]);
  function connect(){
    stop();setNotice('');setEvents([]);setLastAt(0);stream.current=new LiveCollectorStream();setDiagnostics(emptyCollectorDiagnostics());
    let url:string;
    try{url=localCollectorUrl(port);}catch{setConnection('error');setNotice('请输入 1024–65535 之间的本机采集端口');return;}
    let opened=false,failed=false;
    const failure=()=>{failed=true;setConnection('error');setNotice('未能连接本机采集服务。请确认服务已运行、端口一致，并允许浏览器访问本地网络。网页无法判断具体失败原因。');resetWelcome();};
    try{
      const ws=new WebSocket(url);socket.current=ws;setConnection('connecting');
      const timeout=connectionTimer.current=setTimeout(()=>{if(socket.current===ws&&ws.readyState===WebSocket.CONNECTING){failed=true;setConnection('error');setNotice('连接超时，请检查本机采集器与浏览器本地网络权限');ws.close();}},30000);
      ws.onopen=()=>{clearTimeout(timeout);if(socket.current===ws){opened=true;setConnection('open');}};
      ws.onmessage=message=>{
        if(socket.current!==ws)return;
        const packet=stream.current.read(message.data);
        setDiagnostics({...stream.current.diagnostics,reasons:{...stream.current.diagnostics.reasons}});
        const event=packet.event;if(!event)return;
        setLastAt(event.receivedAt);
        if(!ledger.current.accept(event))return;
        setEvents(previous=>[...previous.slice(-99),event]);
        if(welcoming.current&&voice.current?.status()!=='unknown'&&Date.now()>=cooldown.current&&!pending.current&&ledger.current.welcome(event)){pending.current=event;setWelcomeState('等待总控空闲，连续入场合并欢迎');}
      };
      ws.onerror=()=>{if(socket.current===ws){clearTimeout(timeout);failure();}};
      ws.onclose=()=>{clearTimeout(timeout);if(socket.current===ws){socket.current=null;setEvents([]);resetWelcome();if(!opened||failed){if(!failed)failure();}else{setConnection('off');setNotice('本机采集连接已断开，请手动重连；自动欢迎已关闭');}}};
    }catch{failure();}
  }
  return <>
    <button type="button" className="button button--secondary" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MessagesSquare size={17}/>{t('互动消息')}{connection==='open'&&<span aria-label={t('本机采集已连接')}>●</span>}</button>
    {createPortal(<section ref={panel} style={dragging.style} className="live-interactions" role="dialog" aria-label={t('直播互动消息')} hidden={!open}>
      <header className="voice-drag-handle" {...dragging.handle}><strong>{t('直播互动消息')}</strong><button type="button" className="icon-button" aria-label={t('收起互动消息')} onClick={()=>setOpen(false)}><X size={18}/></button></header>
      <p>{t('读取打开网页这台电脑的直播伴侣消息，不是远程主机。仅用于本人直播间。')}</p>
      <p>{t('连接 HomeDouyinCollector，接收直播伴侣新增日志事件；无需确认或固定房间。')}</p>
      <div className="live-interactions__connection"><label>{t('本机采集端口')}<input inputMode="numeric" value={port} disabled={connection==='open'||connection==='connecting'} onChange={e=>setPort(e.target.value)}/></label><button type="button" className="button button--secondary" disabled={connection==='open'||connection==='connecting'} onClick={connect}>{t(connection==='connecting'?'正在连接…':connection==='error'?'重试连接':'连接采集器')}</button><button type="button" className="button button--secondary" disabled={connection==='off'} onClick={stop}>{t('停止接收')}</button></div>
      <p role="status">{t(connection==='open'?'本机采集已连接':connection==='connecting'?'连接本机采集中':connection==='error'?'采集连接失败':'采集未连接')}{lastAt>0&&<> · {t('最后收到事件')} {new Date(lastAt).toLocaleTimeString()}</>}</p>
      {notice&&<p role="alert">{t(notice)}</p>}
      {connection==='open'&&<div className="live-interactions__diagnostics" aria-label={t('采集诊断')}>
        <p>{t('收到数据包')} {diagnostics.packets} · {t('聊天事件')} {diagnostics.chat} · {t('独立入场事件')} {diagnostics.enter}</p>
        {diagnostics.packets===0?<p>{t('连接成功，但尚未收到任何数据。请先查看采集器窗口是否有消息；不要重启正在直播的伴侣。')}</p>:<p>{t('最后收到数据')} {new Date(diagnostics.lastPacketAt).toLocaleTimeString()}</p>}
        {diagnostics.enter===0&&<p>{t('尚未收到独立入场事件，聊天不会触发欢迎')}</p>}
        {diagnostics.rejected>0&&<details><summary>{t('查看接收诊断')}</summary>
          <p>{t('拒收数据包')} {diagnostics.rejected}</p>
          {diagnostics.reasons.native&&<p>{t('不是受支持的原生聊天或入场动作，已拒收')}</p>}
          {diagnostics.reasons.stale&&<p>{t('事件已过期或时间无效，已拒收；请检查本机时间')}</p>}
          {diagnostics.reasons.source&&<p>{t('来源不是直播伴侣，请检查采集器的进程筛选')} · {diagnostics.reasons.source}</p>}
          {diagnostics.reasons.unsupported&&<p>{t('其他互动类型不作为聊天或入场展示')} · {diagnostics.reasons.unsupported}</p>}
          {(diagnostics.reasons.binary||diagnostics.reasons.format||diagnostics.reasons.oversize)&&<p>{t('数据格式不兼容或超过大小限制，请核对采集器版本和 JSON 输出')}</p>}
          {(diagnostics.reasons.room||diagnostics.reasons.message)&&<p>{t('消息缺少房间编号、消息编号或聊天文字，无法可靠接收')}</p>}
        </details>}
      </div>}
      {connection==='open'&&<><label><input type="checkbox" checked={enabled} disabled={!enabled&&voiceStatus==='unavailable'} onChange={e=>{welcoming.current=e.target.checked;setEnabled(e.target.checked);pending.current=null;setWelcomeState(e.target.checked?(voiceStatus==='unknown'?'已开启，等待语音状态就绪':'等待新的入场事件'):'未开启');}}/>{t('入场自动欢迎')}</label><p>{t('固定欢迎语：嗨，你好，欢迎光临')}</p><p role="status">{t(welcomeState)}</p></>}
      {!supported&&<p role="status">{t('自动欢迎需要语音主机连接服务 0.30.100 或更新版本，请在通话结束后更新')}</p>}
      <p className="live-interactions__hint">{t(voiceStatus==='unavailable'?'请在本页连接语音总控；恢复或断线时自动关闭欢迎':voiceStatus==='unknown'?'总控状态暂不可用，等待恢复后接收新的入场事件':voiceStatus==='busy'?'任务结果优先或欢迎间隔中，请稍候':'语音总控已就绪')}</p>
      <p className="live-interactions__hint">{t('同一观众十分钟内不重复欢迎；全局至少间隔三十秒，连续入场合并，等待超过二十秒跳过。')}</p>
      <div ref={messages} onScroll={e=>{const area=e.currentTarget;setFollow(area.scrollHeight-area.scrollTop-area.clientHeight<30);}} className="live-interactions__messages" aria-label={t('收到的互动消息')}>{!events.length?<p>{t('等待新服务推送聊天或独立入场事件')}</p>:events.map(event=><article key={`${event.roomId}:${event.type}:${event.id}`}><span>{t(event.type==='chat'?'聊天':'入场')}</span><strong>{displayName(event.name)||t('匿名观众')}</strong><time>{new Date(event.receivedAt).toLocaleTimeString()}</time><p>{event.type==='chat'?displayName(event.content):t('进入直播间')}</p></article>)}</div>
      {!follow&&<button type="button" className="button button--secondary" onClick={()=>setFollow(true)}>{t('跟随最新')}</button>}
      <details><summary>{t('接入说明与限制')}</summary><p>{t('首次连接时，请允许浏览器访问本机网络；如果先前拒绝，请在站点权限中修改后重新连接。')}</p><p>{t('停止后不再请求欢迎；已送达总控的欢迎可能仍会播放。')}</p><p>{t('新服务默认端口 18888。此面板不会启动、重启或修改采集服务。')}</p><p>{t('这是本机非官方采集接入，不是抖音账号认证。新服务不限制房间；仅处理独立原生入场，不用聊天推断入场。')}</p><p>{t('聊天与昵称不会发给 AI，也不会执行观众指令。仅保留本页最近一百条消息，关闭弹窗继续接收，停止或离开页面停止欢迎。')}</p></details>
    </section>,document.body)}
  </>;
}
