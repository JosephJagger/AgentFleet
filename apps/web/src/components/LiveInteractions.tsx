import {readReloadConnection,saveReloadConnection,clearReloadConnection} from '../lib/reload-connections';
import {api} from '../lib/api';
import {LiveChatUpload} from '../lib/live-chat-upload';
import {useEffect,useId,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {Heart,ArrowDown,MessagesSquare,MessageCircle,Radio,Settings2,UserRound,Volume2,X} from 'lucide-react';
import {t} from '../i18n';
import {displayName} from '../lib/display-name';
import {useDraggablePanel} from '../lib/use-draggable-panel';
import {savedWelcomeText,normalizeWelcomeText,LIVE_WELCOME_STORAGE_KEY,LIVE_WELCOME_INTERVAL_MS,LIVE_WELCOME_MAX_AGE_MS,LiveEventLedger,LiveCollectorStream,emptyCollectorDiagnostics,localCollectorUrl,type LiveEvent,type WelcomeBridge} from '../lib/live-interactions';

const skippedReason=(reason?:string)=>({
  welcome_text:'欢迎语无效，请编辑后重新保存',
  event_time:'事件时间超出允许范围，请校准直播电脑时间',
  protocol:'欢迎请求协议不匹配，请在通话结束后刷新页面',
  identifiers:'入场标识不完整，本次未播报',
  task_priority:'任务或结果播报优先，本次已跳过',
  tool_active:'总控正在处理工具调用，本次已跳过',
  duplicate_event:'重复入场事件，本次不重复欢迎',
  repeat_viewer:'该观众十分钟内已处理，本次不重复欢迎',
  cooldown:'欢迎间隔未到，本次已跳过',
  capacity:'本次通话欢迎记录已达上限',
  agent_version:'语音主机版本不支持欢迎',
  call_inactive:'语音通话未就绪，本次已跳过',
  recovering:'语音连接恢复中，本次已跳过',
  task_status:'任务状态暂不可用，本次已跳过',
  transport:'欢迎未能发送到语音主机，不重试',
  request_failed:'欢迎请求处理失败或过于频繁，本次已跳过',
} as Record<string,string>)[reason??'']??'欢迎请求被拒绝，原因未返回';

export function LiveInteractions({voice,supported=true}:{voice:RefObject<WelcomeBridge|null>;supported?:boolean}) {
  const [reloadPort]=useState(()=>readReloadConnection('collector'));
  const [open,setOpen]=useState(false),[port,setPort]=useState(reloadPort||'18888');
  const connectedPort=useRef('');
  const [view,setView]=useState<'messages'|'settings'>('messages');
  const [filter,setFilter]=useState<'all'|'chat'|'enter'|'interaction'>('all');
  const trigger=useRef<HTMLButtonElement>(null),panelId=useId();

  const [diagnostics,setDiagnostics]=useState(emptyCollectorDiagnostics);
  const stream=useRef(new LiveCollectorStream());
  const connectionTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [connection,setConnection]=useState<'off'|'connecting'|'open'|'error'>('off');
  const chatUpload=useRef(new LiveChatUpload((events,signal)=>api.storeLiveChat(events,signal)));
  const [chatSave,setChatSave]=useState('');
  useEffect(()=>{const timer=setInterval(()=>{void chatUpload.current.flush().then(status=>{if(status)setChatSave(status==='saved'?'聊天已保存，可由总控按需查询':status==='partial'?'聊天已保存；断线积压超限，部分旧消息未保存':'聊天保存失败，稍后重试；总控可能查不到最新消息');});},1000);return()=>{clearInterval(timer);chatUpload.current.clear();};},[]);
  const [notice,setNotice]=useState(''),[enabled,setEnabled]=useState(false),[voiceStatus,setVoiceStatus]=useState('unavailable');
  const [welcomeText,setWelcomeText]=useState(savedWelcomeText);
  const savedText=useRef(welcomeText);
  const [editingText,setEditingText]=useState(false),[draftText,setDraftText]=useState(welcomeText),[textNotice,setTextNotice]=useState('');
  const welcomeEditor=useRef<HTMLTextAreaElement>(null);
  function insertUsername(){
    const area=welcomeEditor.current,start=area?.selectionStart??draftText.length,end=area?.selectionEnd??start;
    const next=draftText.slice(0,start)+'{用户名}'+draftText.slice(end);
    if(next.length>200){setTextNotice('插入后超过 200 个字符，请先缩短欢迎语');return;}
    setDraftText(next);setTextNotice('');
    requestAnimationFrame(()=>{welcomeEditor.current?.focus();welcomeEditor.current?.setSelectionRange(start+5,start+5);});
  }
  function saveText(){
    const next=normalizeWelcomeText(draftText);
    if(!next){setTextNotice('请输入 1–200 个字符的欢迎语');return;}
    try{localStorage.setItem(LIVE_WELCOME_STORAGE_KEY,next);}catch{setTextNotice('保存失败，仍使用原欢迎语；请检查浏览器存储设置');return;}
    savedText.current=next;setWelcomeText(next);setDraftText(next);setEditingText(false);setTextNotice('已保存，下次欢迎请求使用新内容');
  }
  const [events,setEvents]=useState<LiveEvent[]>([]);
  const messages=useRef<HTMLDivElement>(null);
  const [follow,setFollow]=useState(true);
  useEffect(()=>{if(open&&follow&&messages.current)messages.current.scrollTop=messages.current.scrollHeight;},[events,open,follow,filter,view]);
  useEffect(()=>{
    if(!open||!follow||view!=='messages'||!messages.current||typeof ResizeObserver==='undefined')return;
    const area=messages.current,observer=new ResizeObserver(()=>{area.scrollTop=area.scrollHeight;});
    observer.observe(area);return()=>observer.disconnect();
  },[open,follow,view]);
  const [lastAt,setLastAt]=useState(0),[welcomeState,setWelcomeState]=useState('未开启');
  const panel=useRef<HTMLElement>(null),dragging=useDraggablePanel(panel,open);
  const socket=useRef<WebSocket|null>(null),welcoming=useRef(false);
  const pending=useRef<LiveEvent[]>([]),inFlight=useRef<{event:LiveEvent;sentAt:number}|null>(null),cooldown=useRef(0),ledger=useRef(new LiveEventLedger()),lastReceipt=useRef('');
  const resetWelcome=()=>{welcoming.current=false;pending.current=[];inFlight.current=null;setEnabled(false);setWelcomeState('未开启');};
  const stop=()=>{clearReloadConnection('collector');connectedPort.current='';chatUpload.current.clear();setChatSave('');setLastAt(0);setFollow(true);setEvents([]);clearTimeout(connectionTimer.current);const previous=socket.current;socket.current=null;previous?.close();resetWelcome();setConnection('off');setNotice('');};
  useEffect(()=>{const logout=()=>stop();const leave=()=>{const resume=socket.current?.readyState===1?connectedPort.current:'';stop();if(resume)saveReloadConnection('collector',resume);};window.addEventListener('agentfleet:logout',logout);window.addEventListener('pagehide',leave);return()=>{window.removeEventListener('agentfleet:logout',logout);window.removeEventListener('pagehide',leave);const previous=socket.current;socket.current=null;previous?.close();pending.current=[];inFlight.current=null;clearTimeout(connectionTimer.current);};},[]);
  useEffect(()=>{if(open)panel.current?.focus({preventScroll:true});},[open]);
  useEffect(()=>{
    const timer=setInterval(()=>{
      const bridge=voice.current,status=!supported?'unavailable':bridge?.status()??'unavailable';setVoiceStatus(status);
      const receipt=bridge?.receipt;
      if(!welcoming.current)return;
      const now=Date.now();
      if(receipt&&`${receipt.requestId}:${receipt.status}`!==lastReceipt.current){
        lastReceipt.current=`${receipt.requestId}:${receipt.status}`;
        const retryable=receipt.status==='skipped'&&['cooldown','tool_active','task_priority','recovering','call_inactive','task_status'].includes(receipt.reason??'');
        if(retryable&&inFlight.current&&now-inFlight.current.event.receivedAt<=LIVE_WELCOME_MAX_AGE_MS){
          pending.current=[inFlight.current.event,...pending.current].slice(0,50);
          cooldown.current=now+LIVE_WELCOME_INTERVAL_MS;
          setWelcomeState('等待当前播报或工具调用结束后欢迎');
        }else setWelcomeState(receipt.status==='accepted'?'已送达总控，未确认实际播音':receipt.status==='requested'?'已请求欢迎，等待回执':receipt.status==='skipped'?skippedReason(receipt.reason):'送达未确认，不重试');
        if(receipt.status!=='requested')inFlight.current=null;
      }
      // Only an explicit refusal may be retried. Uncertain delivery is never replayed.
      if(inFlight.current){
        if(now-inFlight.current.sentAt<=10000)return;
        inFlight.current=null;setWelcomeState('送达未确认，不重试');
      }
      const before=pending.current.length;
      pending.current=pending.current.filter(entry=>now-entry.receivedAt<=LIVE_WELCOME_MAX_AGE_MS);
      if(before&&!pending.current.length)setWelcomeState('等待超时，已跳过');
      if(status==='unavailable'||status==='unknown'){setWelcomeState('已开启，等待语音连接就绪');return;}
      if(!pending.current.length){setWelcomeState(previous=>previous==='已开启，等待语音连接就绪'?'等待新的入场事件':previous);return;}
      if(status!=='ready'||now<cooldown.current)return;
      const entry=pending.current[0];
      if(bridge?.send(entry,savedText.current)){pending.current.shift();inFlight.current={event:entry,sentAt:now};cooldown.current=now+LIVE_WELCOME_INTERVAL_MS;setWelcomeState('已请求欢迎，等待回执');}

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
      ws.onopen=()=>{clearTimeout(timeout);if(socket.current===ws){connectedPort.current=port;opened=true;setConnection('open');}};
      ws.onmessage=message=>{
        if(socket.current!==ws)return;
        const packet=stream.current.read(message.data);
        setDiagnostics({...stream.current.diagnostics,reasons:{...stream.current.diagnostics.reasons}});
        const event=packet.event;if(!event)return;
        setLastAt(event.receivedAt);
        if(!ledger.current.accept(event))return;
        setEvents(previous=>[...previous.slice(-99),event]);
        chatUpload.current.add(event);
        if(welcoming.current&&ledger.current.welcome(event)){pending.current=[...pending.current,event].slice(-50);setWelcomeState('新观众入场，等待欢迎');}
      };
      ws.onerror=()=>{if(socket.current===ws){clearTimeout(timeout);failure();}};
      ws.onclose=()=>{clearTimeout(timeout);if(socket.current===ws){socket.current=null;setEvents([]);resetWelcome();if(!opened||failed){if(!failed)failure();}else{setConnection('off');setNotice('本机采集连接已断开，请手动重连；自动欢迎已关闭');}}};
    }catch{failure();}
  }
  useEffect(()=>{if(!reloadPort){clearReloadConnection('collector');return;}const timer=setTimeout(()=>{clearReloadConnection('collector');connect();},0);return()=>clearTimeout(timer);},[]);
  const visibleEvents=events.filter(event=>filter==='all'||event.type===filter);
  const close=()=>{setOpen(false);trigger.current?.focus({preventScroll:true});};
  const connectionLabel=connection==='open'?'本机采集已连接':connection==='connecting'?'连接本机采集中':connection==='error'?'采集连接失败':'采集未连接';
  const time=(at:number)=>new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  return <>
    <button ref={trigger} type="button" className="button button--secondary" aria-label={t('互动消息')} aria-expanded={open} aria-controls={panelId} onClick={()=>open?close():setOpen(true)}><MessagesSquare size={17}/><span>{t('互动消息')}</span>{connection==='open'&&<i className="live-interactions__indicator" aria-label={t('本机采集已连接')}/>}</button>
    {createPortal(<section id={panelId} ref={panel} tabIndex={-1} style={dragging.style} className="live-interactions" role="dialog" aria-label={t('直播互动消息')} hidden={!open} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}>
      <header className="live-interactions__header voice-drag-handle" {...dragging.handle}>
        <div className="live-interactions__title"><MessagesSquare size={18}/><strong>{t('直播互动消息')}</strong><span>{t('直播伴侣')}</span></div>
        <button type="button" className="icon-button" aria-label={t('收起互动消息')} onClick={close}><X size={17}/></button>
      </header>
      <div className="live-interactions__connection">
        <span className="live-interactions__state" data-state={connection} role="status"><i aria-hidden="true"/>{t(connectionLabel)}</span>
        {connection==='open'?<button type="button" className="button button--quiet" onClick={stop}>{t('停止接收')}</button>:<>
          <label className="live-interactions__port"><span>{t('本机采集端口')}</span><input inputMode="numeric" autoComplete="off" value={port} disabled={connection==='connecting'} onChange={e=>setPort(e.target.value)}/></label>
          <button type="button" className="button button--primary" disabled={connection==='connecting'} onClick={connect}>{t(connection==='connecting'?'正在连接…':connection==='error'?'重试连接':'连接采集器')}</button>
          {connection==='connecting'&&<button type="button" className="button button--quiet" onClick={stop}>{t('停止接收')}</button>}
        </>}
      </div>
      {notice&&<p className="live-interactions__notice" role="alert">{t(notice)}</p>}
      <div className="live-interactions__tabs" role="group" aria-label={t('互动面板视图')}>
        <button type="button" aria-pressed={view==='messages'} onClick={()=>setView('messages')}><MessageCircle size={14}/>{t('实时消息')}<span>{events.length}</span></button>
        <button type="button" aria-pressed={view==='settings'} onClick={()=>setView('settings')}><Settings2 size={14}/>{t('接入与诊断')}{diagnostics.rejected>0&&<i aria-label={t('存在拒收数据包')}/>}</button>
      </div>
      <div className="live-interactions__feed" hidden={view!=='messages'}>
        <div className="live-interactions__toolbar">
          <div className="live-interactions__filters" role="group" aria-label={t('消息类型')}>
            {([['all','全部'],['chat','聊天'],['enter','入场'],['interaction','互动']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setFollow(true);}}>{t(label)}<span>{value==='all'?events.length:events.filter(event=>event.type===value).length}</span></button>)}
          </div>
          <span className="live-interactions__retention">{t('最近 100 条')}</span>
        </div>
        <div ref={messages} tabIndex={0} onScroll={e=>{const area=e.currentTarget;setFollow(area.scrollHeight-area.scrollTop-area.clientHeight<30);}} className="live-interactions__messages" role="region" aria-label={t('收到的互动消息')}>
          {!visibleEvents.length?<div className="live-interactions__empty"><Radio size={26} aria-hidden="true"/><strong>{t(connection==='open'?'等待新消息':connection==='connecting'?'正在连接本机采集器':connection==='error'?'暂时无法接收消息':'连接后查看直播消息')}</strong><p>{t(events.length?'当前筛选下暂无消息':connection==='open'?'聊天、入场、点赞和礼物等消息会显示在这里':connection==='error'?'请检查采集器是否运行，然后重试连接。':'打开本机直播伴侣和采集器，然后连接采集器。')}</p></div>:visibleEvents.map(event=><article className="live-interactions__message" data-kind={event.type} key={`${event.roomId}:${event.type}:${event.id}`}>
            <span className="live-interactions__avatar" aria-hidden="true">{event.type==='chat'?<MessageCircle size={15}/>:event.type==='enter'?<UserRound size={15}/>:<Heart size={15}/>}</span>
            <div className="live-interactions__message-body"><div className="live-interactions__message-meta"><strong title={displayName(event.name)||t('匿名观众')}>{displayName(event.name)||t('匿名观众')}</strong><span className="live-interactions__kind">{t(event.type==='chat'?'聊天':event.type==='enter'?'入场':event.interaction?({like:'点赞',follow:'关注',gift:'礼物',fansclub:'粉丝团',share:'分享'} as const)[event.interaction]:'互动')}</span><time dateTime={new Date(event.receivedAt).toISOString()}>{time(event.receivedAt)}</time></div><p>{event.type==='enter'?t('进入直播间'):event.content?displayName(event.content):event.interaction==='gift'?t('送出 {0} × {1}',displayName(event.giftName)||t('礼物'),event.count??1):event.interaction==='like'?t('为直播间点赞 × {0}',event.count??1):t(event.interaction==='follow'?'关注了主播':event.interaction==='share'?'分享了直播间':'粉丝团互动')}</p></div>
          </article>)}
        </div>
        <div className="live-interactions__feed-footer"><span>{lastAt>0?<>{t('最后收到事件')} {time(lastAt)}</>:t('仅接收本机直播伴侣的新消息')}</span>{!follow?<button type="button" onClick={()=>setFollow(true)}><ArrowDown size={13}/>{t('跟随最新')}</button>:<span className="live-interactions__following"><ArrowDown size={12}/>{t('跟随最新')}</span>}</div>
      </div>
      <div className="live-interactions__settings" hidden={view!=='settings'}>
        <p>{t('真实聊天按当前账号保存在服务器，最多最近 100 条、最长 24 小时，可跨通话查询；总控仅在你要求时查找并回答，不自动回复观众。')}</p>
        <p>{t('总控聊天检索需要语音主机 0.30.101 或更新版本，更新后重新连接总控。')}</p>
        {chatSave&&<p role="status">{t(chatSave)}</p>}
        <p>{t('读取打开网页这台电脑的直播伴侣消息，不是远程主机。仅用于本人直播间。')}</p>
        <p className="live-interactions__hint">{t('连接 HomeDouyinCollector，接收入场、聊天和互动事件；无需确认或固定房间。')}</p>
      {connection==='open'&&<div className="live-interactions__diagnostics" aria-label={t('采集诊断')}>
        <p>{t('收到数据包')} {diagnostics.packets} · {t('聊天事件')} {diagnostics.chat} · {t('独立入场事件')} {diagnostics.enter} · {t('其他互动')} {diagnostics.interaction}</p>
        {diagnostics.packets===0?<p>{t('连接成功，但尚未收到任何数据。请先查看采集器窗口是否有消息；不要重启正在直播的伴侣。')}</p>:<p>{t('最后收到数据')} {new Date(diagnostics.lastPacketAt).toLocaleTimeString()}</p>}
        {diagnostics.enter===0&&<p>{t('尚未收到独立入场事件，聊天不会触发欢迎')}</p>}
        {diagnostics.rejected>0&&<details><summary>{t('查看接收诊断')}</summary>
          <p>{t('拒收数据包')} {diagnostics.rejected}</p>
          {diagnostics.reasons.native&&<p>{t('来源、传输方式或原生消息类型不匹配，已拒收')}</p>}
          {diagnostics.reasons.stale&&<p>{t('事件已过期或时间无效，已拒收；请检查本机时间')}</p>}
          {diagnostics.reasons.source&&<p>{t('数据来源与进程不匹配，请检查采集器版本')} · {diagnostics.reasons.source}</p>}
          {diagnostics.reasons.unsupported&&<p>{t('暂不支持的数据类型，未显示为消息')} · {diagnostics.reasons.unsupported}</p>}
          {(diagnostics.reasons.binary||diagnostics.reasons.format||diagnostics.reasons.oversize)&&<p>{t('数据格式不兼容或超过大小限制，请核对采集器版本和 JSON 输出')}</p>}
          {(diagnostics.reasons.room||diagnostics.reasons.message)&&<p>{t('消息缺少房间编号、消息编号或聊天文字，无法可靠接收')}</p>}
        </details>}
      </div>}
        <p className="live-interactions__hint">{t('支持伴侣内部聊天桥接及独立浏览器互动消息；自动欢迎仅使用伴侣日志的独立入场事件。')}</p>
        <p className="live-interactions__hint">{t('每次新入场都可欢迎，不限制同一观众；播报间隔 3 秒，忙时依次等待，最多保留 2 分钟。')}</p>
      <details><summary>{t('接入说明与限制')}</summary><p>{t('首次连接时，请允许浏览器访问本机网络；如果先前拒绝，请在站点权限中修改后重新连接。')}</p><p>{t('停止后不再请求欢迎；已送达总控的欢迎可能仍会播放。')}</p><p>{t('新服务默认端口 18888。此面板不会启动、重启或修改采集服务。')}</p><p>{t('这是本机非官方采集接入，不是抖音账号认证。新服务不限制房间；聊天和互动正常展示，只有独立入场触发欢迎。')}</p><p>{t('聊天仅在你要求查询时交给总控回答，观众文本不是执行指令；入场昵称仅用于本次欢迎。关闭弹窗继续接收，停止或离开页面停止欢迎，已保存聊天按保留规则过期。')}</p></details>
      </div>
      <footer className="live-interactions__welcome">
        <div className="live-interactions__welcome-heading"><Volume2 size={15}/><strong>{t('入场自动欢迎')}</strong>{connection==='open'&&<label className="live-interactions__switch"><input type="checkbox" aria-label={t('入场自动欢迎')} checked={enabled} disabled={!enabled&&!supported} onChange={e=>{welcoming.current=e.target.checked;setEnabled(e.target.checked);pending.current=[];inFlight.current=null;setWelcomeState(e.target.checked?(voiceStatus==='unknown'||voiceStatus==='unavailable'?'已开启，等待语音连接就绪':'等待新的入场事件'):'未开启');}}/><span aria-hidden="true"/></label>}</div>
        {connection==='open'&&<><p className="live-interactions__welcome-status" role="status">{t(welcomeState)}</p></>}
        <div className="live-interactions__welcome-text">
          <div className="live-interactions__welcome-text-heading"><strong>{t('欢迎语')}</strong>{!editingText&&<button type="button" className="button button--quiet" onClick={()=>{setDraftText(welcomeText);setTextNotice('');setEditingText(true);}}>{t('编辑欢迎语')}</button>}</div>
          {editingText?<><label><span className="live-interactions__hint">{t('欢迎语内容')}</span><textarea ref={welcomeEditor} aria-label={t('欢迎语内容')} maxLength={200} rows={3} value={draftText} onChange={e=>{setDraftText(e.target.value);setTextNotice('');}}/></label><div className="live-interactions__welcome-text-actions"><button type="button" className="button button--quiet" onClick={insertUsername}>{t('插入 {用户名}')}</button><small>{draftText.length}/200</small><button type="button" className="button button--quiet" onClick={()=>{setEditingText(false);setDraftText(welcomeText);setTextNotice('');}}>{t('取消')}</button><button type="button" className="button button--primary" onClick={saveText}>{t('保存欢迎语')}</button></div></>:<p className="live-interactions__saved-text">{welcomeText}</p>}
          <p className="live-interactions__hint">{t('参数 {用户名} 可放在任意位置，替换为本次入场观众的显示昵称；缺少昵称时使用“这位朋友”。')}</p>
          {textNotice&&<p role="status" className="live-interactions__hint">{t(textNotice)}</p>}
          <p className="live-interactions__hint">{t('仅保存在当前浏览器；编辑后需保存，已发送的欢迎不受影响。')}</p>
        </div>
        {!supported&&<p role="status">{t('自动欢迎需要语音主机连接服务 0.30.100 或更新版本，请在通话结束后更新')}</p>}
        <p className="live-interactions__hint">{t(voiceStatus==='unavailable'?'连接语音总控后即可欢迎；短暂断线会等待恢复':voiceStatus==='unknown'?'语音连接恢复中，入场消息会暂存等待':voiceStatus==='busy'?'正在等待上一条欢迎结束，请稍候':'语音总控已就绪')}</p>
      </footer>
    </section>,document.body)}
  </>;
}
