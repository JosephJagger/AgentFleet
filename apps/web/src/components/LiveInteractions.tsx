import {useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {MessagesSquare,X} from 'lucide-react';
import {t} from '../i18n';
import {displayName} from '../lib/display-name';
import {useDraggablePanel} from '../lib/use-draggable-panel';
import {LiveEventLedger,LiveCollectorStream,LiveRoomMarker,emptyCollectorDiagnostics,localCollectorUrl,sameRoom,type LiveEvent,type WelcomeBridge} from '../lib/live-interactions';

export function LiveInteractions({voice,supported=true}:{voice:RefObject<WelcomeBridge|null>;supported?:boolean}) {
  const [open,setOpen]=useState(false),[port,setPort]=useState('8888');
  const [diagnostics,setDiagnostics]=useState(emptyCollectorDiagnostics),[markerText,setMarkerText]=useState('');
  const stream=useRef(new LiveCollectorStream()),marker=useRef(new LiveRoomMarker()),buffer=useRef<LiveEvent[]>([]);
  const connectionTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const clearMarker=()=>{marker.current.clear();setMarkerText('');};
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
  const stop=()=>{setEvents([]);buffer.current=[];clearTimeout(connectionTimer.current);clearMarker();const previous=socket.current;socket.current=null;previous?.close();selected.current=null;setRoom(null);setRooms([]);resetWelcome();setConnection('off');setNotice('');};
  useEffect(()=>{const logout=()=>stop();window.addEventListener('agentfleet:logout',logout);window.addEventListener('pagehide',logout);return()=>{window.removeEventListener('agentfleet:logout',logout);window.removeEventListener('pagehide',logout);const previous=socket.current;socket.current=null;previous?.close();pending.current=null;clearTimeout(connectionTimer.current);};},[]);
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
    stop();setNotice('');setEvents([]);setLastAt(0);stream.current=new LiveCollectorStream();setDiagnostics(emptyCollectorDiagnostics());buffer.current=[];
    let url:string;
    try{url=localCollectorUrl(port);}catch{setConnection('error');setNotice('请输入 1024–65535 之间的本机采集端口');return;}
    let opened=false,failed=false;
    const failure=()=>{failed=true;setConnection('error');setNotice('未能连接本机采集器。请确认这台电脑已运行 DouyinBarrageGrab、WebSocket 端口一致，并允许浏览器访问本地网络。网页无法判断具体失败原因。');resetWelcome();};
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
        if(event.type==='end'){
          if(selected.current?.roomId===event.roomId){selected.current=null;setRoom(null);setEvents([]);resetWelcome();setNotice('收到下播事件，请重新确认房间');}
          clearMarker();buffer.current=buffer.current.filter(item=>item.roomId!==event.roomId);
          setRooms(previous=>previous.filter(item=>item.roomId!==event.roomId));return;
        }
        setRooms(previous=>[event,...previous.filter(item=>item.roomId!==event.roomId)].slice(0,5));
        if(event.type==='start'){
          selected.current=null;setRoom(null);setEvents([]);buffer.current=[];clearMarker();resetWelcome();setNotice('收到开播事件，请确认本人房间');return;
        }
        marker.current.observe(event);
        if(selected.current&&!sameRoom(selected.current,event)){
          selected.current=null;setRoom(null);setEvents([]);clearMarker();resetWelcome();setNotice('房间或主播资料已变化，请重新确认；自动欢迎已关闭');
        }
        if(event.type==='room')return;
        if(!ledger.current.accept(event))return;
        buffer.current=[...buffer.current.slice(-99),event];
        if(!selected.current)return;
        setEvents(previous=>[...previous.slice(-99),event]);
        if(welcoming.current&&event.type==='enter'&&Date.now()>=cooldown.current&&!pending.current&&ledger.current.welcome(event)){pending.current=event;setWelcomeState('等待总控空闲，连续入场合并欢迎');}
      };
      ws.onerror=()=>{if(socket.current===ws){clearTimeout(timeout);failure();}};
      ws.onclose=()=>{clearTimeout(timeout);if(socket.current===ws){socket.current=null;setEvents([]);buffer.current=[];clearMarker();selected.current=null;setRoom(null);setRooms([]);resetWelcome();if(!opened||failed){if(!failed)failure();}else{setConnection('off');setNotice('本机采集连接已断开，请手动重连并确认房间');}}};
    }catch{failure();}
  }
  function confirm(candidate:LiveEvent){
    if(!candidate.ownerId&&!marker.current.matches(candidate.roomId)){setNotice('请先发送校验文字并等待匹配，或等待主播资料；校验文字五分钟有效');return;}
    selected.current=candidate;setRoom(candidate);
    // Show already-received chat after confirmation, but never replay buffered entries to voice.
    setEvents(buffer.current.filter(item=>item.roomId===candidate.roomId&&(!item.ownerId||item.ownerId===candidate.ownerId)));
    resetWelcome();setFollow(true);setNotice('');clearMarker();
  }
  return <>
    <button type="button" className="button button--secondary" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MessagesSquare size={17}/>{t('互动消息')}{connection==='open'&&<span aria-label={t('本机采集已连接')}>●</span>}</button>
    {createPortal(<section ref={panel} style={dragging.style} className="live-interactions" role="dialog" aria-label={t('直播互动消息')} hidden={!open}>
      <header className="voice-drag-handle" {...dragging.handle}><strong>{t('直播互动消息')}</strong><button type="button" className="icon-button" aria-label={t('收起互动消息')} onClick={()=>setOpen(false)}><X size={18}/></button></header>
      <p>{t('读取打开网页这台电脑的直播伴侣消息，不是远程主机。仅用于本人直播间。')}</p>
      <p>{t('请先在这台直播电脑运行 DouyinBarrageGrab 并开启 WebSocket 服务；此按钮只连接，不会安装或启动采集器。')}</p>
      <div className="live-interactions__connection"><label>{t('本机采集端口')}<input inputMode="numeric" value={port} disabled={connection==='open'||connection==='connecting'} onChange={e=>setPort(e.target.value)}/></label><button type="button" className="button button--secondary" disabled={connection==='open'||connection==='connecting'} onClick={connect}>{t(connection==='connecting'?'正在连接…':connection==='error'?'重试连接':'连接采集器')}</button><button type="button" className="button button--secondary" disabled={connection==='off'} onClick={stop}>{t('停止接收')}</button></div>
      <p role="status">{t(connection==='open'?'本机采集已连接':connection==='connecting'?'连接本机采集中':connection==='error'?'采集连接失败':'采集未连接')}{lastAt>0&&<> · {t('最后收到事件')} {new Date(lastAt).toLocaleTimeString()}</>}</p>
      {notice&&<p role="alert">{t(notice)}</p>}
      {connection==='open'&&<div className="live-interactions__diagnostics" aria-label={t('采集诊断')}>
        <p>{t('收到数据包')} {diagnostics.packets} · {t('聊天事件')} {diagnostics.chat} · {t('独立入场事件')} {diagnostics.enter}</p>
        {diagnostics.packets===0?<p>{t('连接成功，但尚未收到任何数据。请先查看采集器窗口是否有消息；不要重启正在直播的伴侣。')}</p>:<p>{t('最后收到数据')} {new Date(diagnostics.lastPacketAt).toLocaleTimeString()}</p>}
        {diagnostics.enter===0&&<p>{t('尚未收到独立入场事件，聊天不会触发欢迎')}</p>}
        {(diagnostics.rejected>0||diagnostics.missingOwner>0)&&<details><summary>{t('查看接收诊断')}</summary>
          <p>{t('拒收数据包')} {diagnostics.rejected} · {t('缺少主播资料')} {diagnostics.missingOwner}</p>
          {diagnostics.reasons.source&&<p>{t('来源不是直播伴侣，请检查采集器的进程筛选')} · {diagnostics.reasons.source}</p>}
          {diagnostics.reasons.unsupported&&<p>{t('其他互动类型不作为聊天或入场展示')} · {diagnostics.reasons.unsupported}</p>}
          {(diagnostics.reasons.binary||diagnostics.reasons.format||diagnostics.reasons.oversize)&&<p>{t('数据格式不兼容或超过大小限制，请核对采集器版本和 JSON 输出')}</p>}
          {(diagnostics.reasons.room||diagnostics.reasons.message)&&<p>{t('消息缺少房间编号、消息编号或聊天文字，无法可靠接收')}</p>}
        </details>}
      </div>}
      {connection==='open'&&!room&&<div className="live-interactions__rooms">
        <strong>{t('确认本人直播间')}</strong><p>{t('来源标记不等于账号授权。请对照直播伴侣中的主播和房间，仅确认你自己的直播间。')}</p>
        {rooms.length===0?<p>{t('等待直播伴侣来源的聊天或入场事件，尚未识别房间')}</p>:rooms.map(candidate=><div key={candidate.roomId}>
          <span>{displayName(candidate.ownerName)||t('主播昵称未知')} · {displayName(candidate.roomTitle)}
            <small>{t('房间编号')} {candidate.roomId} · {t('主播编号')} {candidate.ownerId||t('未提供')}</small>
            {!candidate.ownerId&&<small>{t(marker.current.matches(candidate.roomId)?'已匹配校验文字，请核对后确认':'主播资料未提供，可使用下方校验文字核对消息来源')}</small>}
          </span><button type="button" className="button button--secondary" disabled={!candidate.ownerId&&!marker.current.matches(candidate.roomId)} onClick={()=>confirm(candidate)}>{t('确认这是我的直播间')}</button>
        </div>)}
        <details><summary>{t('没有主播资料？用聊天核对房间')}</summary>
          <p>{t('生成校验文字后，在本人直播间发送同一条普通聊天。收到匹配文字后再确认；这是人工核对，不是抖音账号认证。')}</p>
          <button type="button" className="button button--secondary" onClick={()=>setMarkerText(marker.current.create())}>{t('生成校验文字')}</button>
          {markerText&&<label>{t('校验文字（五分钟有效）')}<input readOnly value={markerText} onFocus={e=>e.currentTarget.select()}/></label>}
        </details>
      </div>}
      {room&&<><p>{t(room.ownerId?'已确认本人房间':'已人工核对消息房间')}：{displayName(room.ownerName)} · {room.roomId}</p>{!room.ownerId&&<p>{t('可查看聊天与独立入场；主播资料未提供，自动欢迎暂不可用')}</p>}<label><input type="checkbox" checked={enabled} disabled={!enabled&&(!room.ownerId||connection!=='open'||voiceStatus==='unavailable'||voiceStatus==='unknown')} onChange={e=>{welcoming.current=e.target.checked;setEnabled(e.target.checked);pending.current=null;setWelcomeState(e.target.checked?'等待新的入场事件':'未开启');}}/>{t('入场自动欢迎')}</label><p>{t('固定欢迎语：嗨，你好，欢迎光临')}</p><p role="status">{t(welcomeState)}</p></>}
      {!supported&&<p role="status">{t('自动欢迎需要语音主机连接服务 0.30.100 或更新版本，请在通话结束后更新')}</p>}
      <p className="live-interactions__hint">{t(voiceStatus==='unavailable'?'请在本页连接语音总控；恢复或断线时自动关闭欢迎':voiceStatus==='unknown'?'未取得原生语音忙闲事件，欢迎暂不可用':voiceStatus==='busy'?'用户对话或任务优先，等待语音总控空闲':'语音总控已就绪')}</p>
      <p className="live-interactions__hint">{t('同一观众十分钟内不重复欢迎；全局至少间隔三十秒，连续入场合并，等待超过二十秒跳过。')}</p>
      <div ref={messages} onScroll={e=>{const area=e.currentTarget;setFollow(area.scrollHeight-area.scrollTop-area.clientHeight<30);}} className="live-interactions__messages" aria-label={t('收到的互动消息')}>{!events.length?<p>{t(room?'已确认房间，等待新的聊天或入场消息':'暂无已确认房间的消息')}</p>:events.map(event=><article key={`${event.type}:${event.id}`}><span>{t(event.type==='chat'?'聊天':'入场')}</span><strong>{displayName(event.name)||t('匿名观众')}</strong><time>{new Date(event.receivedAt).toLocaleTimeString()}</time><p>{event.type==='chat'?displayName(event.content):t('进入直播间')}</p></article>)}</div>
      {!follow&&<button type="button" className="button button--secondary" onClick={()=>setFollow(true)}>{t('跟随最新')}</button>}
      <details><summary>{t('接入说明与限制')}</summary><p>{t('首次连接时，请允许浏览器访问本机网络；如果先前拒绝，请在站点权限中修改后重新连接。')}</p><p>{t('停止后不再请求欢迎；已送达总控的欢迎可能仍会播放。')}</p><p>{t('需要在直播电脑单独运行 DouyinBarrageGrab。使用其本机 WebSocket 输出，来源进程为直播伴侣，推送类型包含 1（聊天）和 3（入场），建议仅监听 127.0.0.1。')}</p><p>{t('这是非官方采集适配，不是抖音授权接口。网页不能自行读取直播伴侣账号；未连接、未确认房间或未收到真实入场事件时，不代表已经接通入场。')}</p><p>{t('聊天与昵称不会发给 AI，也不会执行观众指令。仅保留本页最近一百条消息，关闭弹窗继续接收，停止或离开页面停止欢迎。')}</p><a href="https://github.com/ape-byte/DouyinBarrageGrab" target="_blank" rel="noreferrer">DouyinBarrageGrab</a></details>
    </section>,document.body)}
  </>;
}
