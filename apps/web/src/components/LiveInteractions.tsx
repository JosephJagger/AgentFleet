import {useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {MessagesSquare,X} from 'lucide-react';
import {t} from '../i18n';
import {displayName} from '../lib/display-name';
import {useDraggablePanel} from '../lib/use-draggable-panel';
import {LiveEventLedger,localCollectorUrl,parseLiveEvent,sameRoom,type LiveEvent,type WelcomeBridge} from '../lib/live-interactions';

export function LiveInteractions({voice,supported=true}:{voice:RefObject<WelcomeBridge|null>;supported?:boolean}) {
  const [open,setOpen]=useState(false),[port,setPort]=useState('8888');
  const [connection,setConnection]=useState<'off'|'connecting'|'open'|'error'>('off');
  const [notice,setNotice]=useState(''),[enabled,setEnabled]=useState(false),[voiceStatus,setVoiceStatus]=useState('unavailable');
  const [rooms,setRooms]=useState<LiveEvent[]>([]),[room,setRoom]=useState<LiveEvent|null>(null),[events,setEvents]=useState<LiveEvent[]>([]);
  const messages=useRef<HTMLDivElement>(null);
  const [follow,setFollow]=useState(true);
  useEffect(()=>{if(open&&follow&&messages.current)messages.current.scrollTop=messages.current.scrollHeight;},[events,open,follow]);
  const [lastAt,setLastAt]=useState(0),[welcomeState,setWelcomeState]=useState('未开启');
  const panel=useRef<HTMLElement>(null),dragging=useDraggablePanel(panel,open);
  const socket=useRef<WebSocket|null>(null),selected=useRef<LiveEvent|null>(null),welcoming=useRef(false);
  const pending=useRef<LiveEvent|null>(null),cooldown=useRef(0),ledger=useRef(new LiveEventLedger()),lastReceipt=useRef('');
  const resetWelcome=()=>{welcoming.current=false;pending.current=null;setEnabled(false);setWelcomeState('未开启');};
  const stop=()=>{const previous=socket.current;socket.current=null;previous?.close();selected.current=null;setRoom(null);setRooms([]);resetWelcome();setConnection('off');};
  useEffect(()=>{const logout=()=>stop();window.addEventListener('agentfleet:logout',logout);window.addEventListener('pagehide',logout);return()=>{window.removeEventListener('agentfleet:logout',logout);window.removeEventListener('pagehide',logout);const previous=socket.current;socket.current=null;previous?.close();pending.current=null;};},[]);
  useEffect(()=>{if(!open)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[open]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      const bridge=voice.current,status=!supported?'unavailable':bridge?.status()??'unavailable';setVoiceStatus(status);
      const receipt=bridge?.receipt;
      if(receipt&&`${receipt.requestId}:${receipt.status}`!==lastReceipt.current){lastReceipt.current=`${receipt.requestId}:${receipt.status}`;setWelcomeState(receipt.status==='accepted'?'已送达总控，未确认实际播音':receipt.status==='requested'?'已请求欢迎，等待回执':receipt.status==='skipped'?'总控繁忙，本次已跳过':'送达未确认，不重试');}
      if(!welcoming.current)return;
      if(status==='unavailable'||status==='unknown'){resetWelcome();return;}
      const entry=pending.current;if(!entry)return;
      if(Date.now()-entry.receivedAt>20000){pending.current=null;setWelcomeState('等待超时，已跳过');return;}
      if(status!=='ready')return;
      // One attempt only. Never replay uncertain outcomes or build a growing voice queue.
      if(bridge?.send(entry)){pending.current=null;cooldown.current=Date.now()+30000;setWelcomeState('已请求欢迎，等待回执');}
    },500);
    return()=>clearInterval(timer);
  },[voice,supported]);
  function connect(){
    stop();setNotice('');setEvents([]);setLastAt(0);
    try{
      const ws=new WebSocket(localCollectorUrl(port));socket.current=ws;setConnection('connecting');
      const timeout=setTimeout(()=>{if(socket.current===ws&&ws.readyState===WebSocket.CONNECTING){ws.close();setConnection('error');setNotice('连接超时，请检查本机采集器与浏览器本地网络权限');}},30000);
      ws.onopen=()=>{clearTimeout(timeout);if(socket.current===ws)setConnection('open');};
      ws.onmessage=message=>{
        if(socket.current!==ws||typeof message.data!=='string')return;
        const event=parseLiveEvent(message.data);if(!event)return;
        setLastAt(event.receivedAt);
        if(event.type==='end'){
          if(selected.current&&selected.current.roomId===event.roomId&&(!event.ownerId||sameRoom(selected.current,event))){selected.current=null;setRoom(null);resetWelcome();setNotice('收到下播事件，请重新确认房间');}
          setRooms(previous=>previous.filter(item=>!sameRoom(item,event)));return;
        }
        setRooms(previous=>[event,...previous.filter(item=>!sameRoom(item,event))].slice(0,5));
        if(event.type==='start'){selected.current=null;setRoom(null);resetWelcome();setNotice('收到开播事件，请确认本人房间');return;}
        if(!selected.current)return;
        if(!sameRoom(selected.current,event)){
          // A second companion room may mean an account/live switch. Never follow it silently.
          selected.current=null;setRoom(null);resetWelcome();setNotice('直播伴侣房间已变化，已暂停接收，请确认本人房间');return;
        }
        if(!ledger.current.accept(event))return;
        setEvents(previous=>[...previous.slice(-99),event]);
        if(welcoming.current&&event.type==='enter'&&Date.now()>=cooldown.current&&!pending.current&&ledger.current.welcome(event)){pending.current??=event;setWelcomeState('等待总控空闲，连续入场合并欢迎');}
      };
      ws.onerror=()=>{if(socket.current===ws){setConnection('error');setNotice('无法连接本机采集器，请检查端口及浏览器本地网络权限；不要关闭浏览器安全保护');resetWelcome();}};
      ws.onclose=()=>{clearTimeout(timeout);if(socket.current===ws){socket.current=null;setConnection('off');selected.current=null;setRoom(null);setRooms([]);resetWelcome();setNotice('本机采集连接已断开，请手动重连并确认房间');}};
    }catch{setConnection('error');setNotice('无法连接本机采集器，请检查端口及浏览器本地网络权限；不要关闭浏览器安全保护');}
  }
  function confirm(candidate:LiveEvent){selected.current=candidate;setRoom(candidate);setEvents([]);resetWelcome();setFollow(true);setNotice('');}
  return <>
    <button type="button" className="button button--secondary" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MessagesSquare size={17}/>{t('互动消息')}{connection==='open'&&<span aria-label={t('本机采集已连接')}>●</span>}</button>
    {createPortal(<section ref={panel} style={dragging.style} className="live-interactions" role="dialog" aria-label={t('直播互动消息')} hidden={!open}>
      <header className="voice-drag-handle" {...dragging.handle}><strong>{t('直播互动消息')}</strong><button type="button" className="icon-button" aria-label={t('收起互动消息')} onClick={()=>setOpen(false)}><X size={18}/></button></header>
      <p>{t('读取打开网页这台电脑的直播伴侣消息，不是远程主机。仅用于本人直播间。')}</p>
      <div className="live-interactions__connection"><label>{t('本机采集端口')}<input inputMode="numeric" value={port} disabled={connection==='open'||connection==='connecting'} onChange={e=>setPort(e.target.value)}/></label><button type="button" className="button button--secondary" disabled={connection==='open'||connection==='connecting'} onClick={connect}>{t('连接采集器')}</button><button type="button" className="button button--secondary" disabled={connection==='off'} onClick={stop}>{t('停止接收')}</button></div>
      <p role="status">{t(connection==='open'?'本机采集已连接':connection==='connecting'?'连接本机采集中':connection==='error'?'采集连接失败':'采集未连接')}{lastAt>0&&<> · {t('最后收到事件')} {new Date(lastAt).toLocaleTimeString()}</>}</p>
      {notice&&<p role="alert">{t(notice)}</p>}
      {connection==='open'&&!room&&<div className="live-interactions__rooms"><strong>{t('确认本人直播间')}</strong><p>{t('来源标记不等于账号授权。请对照直播伴侣中的主播和房间，仅确认你自己的直播间。')}</p>{rooms.length===0?<p>{t('等待直播伴侣来源的聊天或入场事件，尚未识别房间')}</p>:rooms.map(candidate=><div key={`${candidate.ownerId}:${candidate.roomId}`}><span>{displayName(candidate.ownerName)||t('主播昵称未知')} · {displayName(candidate.roomTitle)}<small>{t('房间编号')} {candidate.roomId} · {t('主播编号')} {candidate.ownerId}</small></span><button type="button" className="button button--secondary" onClick={()=>confirm(candidate)}>{t('确认这是我的直播间')}</button></div>)}</div>}
      {room&&<><p>{t('已确认本人房间')}：{displayName(room.ownerName)} · {room.roomId}</p><label><input type="checkbox" checked={enabled} disabled={!enabled&&(connection!=='open'||voiceStatus==='unavailable'||voiceStatus==='unknown')} onChange={e=>{welcoming.current=e.target.checked;setEnabled(e.target.checked);pending.current=null;setWelcomeState(e.target.checked?'等待新的入场事件':'未开启');}}/>{t('入场自动欢迎')}</label><p>{t('固定欢迎语：嗨，你好，欢迎光临')}</p><p role="status">{t(welcomeState)}</p></>}
      {!supported&&<p role="status">{t('自动欢迎需要语音主机连接服务 0.30.100 或更新版本，请在通话结束后更新')}</p>}
      <p className="live-interactions__hint">{t(voiceStatus==='unavailable'?'请在本页连接语音总控；恢复或断线时自动关闭欢迎':voiceStatus==='unknown'?'未取得原生语音忙闲事件，欢迎暂不可用':voiceStatus==='busy'?'用户对话或任务优先，等待语音总控空闲':'语音总控已就绪')}</p>
      <p className="live-interactions__hint">{t('同一观众十分钟内不重复欢迎；全局至少间隔三十秒，连续入场合并，等待超过二十秒跳过。')}</p>
      <div ref={messages} onScroll={e=>{const area=e.currentTarget;setFollow(area.scrollHeight-area.scrollTop-area.clientHeight<30);}} className="live-interactions__messages" aria-label={t('收到的互动消息')}>{!events.length?<p>{t('暂无已确认房间的消息')}</p>:events.map(event=><article key={`${event.type}:${event.id}`}><span>{t(event.type==='chat'?'聊天':'入场')}</span><strong>{displayName(event.name)||t('匿名观众')}</strong><time>{new Date(event.receivedAt).toLocaleTimeString()}</time><p>{event.type==='chat'?displayName(event.content):t('进入直播间')}</p></article>)}</div>
      {!follow&&<button type="button" className="button button--secondary" onClick={()=>setFollow(true)}>{t('跟随最新')}</button>}
      <details><summary>{t('接入说明与限制')}</summary><p>{t('首次连接时，请允许浏览器访问本机网络；如果先前拒绝，请在站点权限中修改后重新连接。')}</p><p>{t('停止后不再请求欢迎；已送达总控的欢迎可能仍会播放。')}</p><p>{t('需要在直播电脑单独运行 DouyinBarrageGrab。使用其本机 WebSocket 输出，来源进程为直播伴侣，推送类型包含 1（聊天）和 3（入场），建议仅监听 127.0.0.1。')}</p><p>{t('这是非官方采集适配，不是抖音授权接口。网页不能自行读取直播伴侣账号；未连接、未确认房间或未收到真实入场事件时，不代表已经接通入场。')}</p><p>{t('聊天与昵称不会发给 AI，也不会执行观众指令。仅保留本页最近一百条消息，关闭弹窗继续接收，停止或离开页面停止欢迎。')}</p><a href="https://github.com/ape-byte/DouyinBarrageGrab" target="_blank" rel="noreferrer">DouyinBarrageGrab</a></details>
    </section>,document.body)}
  </>;
}
