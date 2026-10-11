import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Activity,Layers3,ChevronLeft,ChevronRight,Terminal} from 'lucide-react';
import {displayName} from '../lib/display-name';
import {hostSessionGroups} from '../lib/host-session-selection';
import {t} from '../i18n';
import type {FleetSession,Machine,SessionDetail} from '../lib/types';
import {useSessionProgress} from './RuntimeProgress';

function SessionWindow({session,selected,running,online,detail,onSelect}:{session:FleetSession;selected:boolean;running:boolean;online:boolean;detail?:SessionDetail;onSelect:(id:string)=>void}) {
  const element=useRef<HTMLButtonElement>(null);
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!element.current || typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)));
    observer.observe(element.current);return()=>observer.disconnect();
  },[]);
  const {progress}=useSessionProgress(session.id,running&&visible&&!selected);
  const scoped=progress?.sessionId===session.id && progress.nativeTurnId===session.activeTurnId && progress.contentAvailable ? progress : undefined;
  const current=detail?.session.id===session.id && detail.session.activeTurnId===session.activeTurnId ? detail : undefined;
  const event=current?.events.filter(e=>e.nativeTurnId===session.activeTurnId&&e.payloadState!=='deleted'&&e.payloadState!=='suppressed'&&(e.command||e.itemType==='fileChange'||e.itemType==='reasoning')).at(-1);
  const status=!online || session.state.reachability!=='live'?t('等待主机连接'):session.state.unknownFreeze?t('结果待核验'):session.state.waitReason==='approval'?t('等待确认'):session.state.waitReason==='user_input'?t('等待回答'):running?t('运行中'):t('空闲');
  const preview=running && session.state.waitReason==='none' ? event?.command || (event?.itemType==='fileChange'?t('修改文件'):event?.itemType==='reasoning'?t('推理中'):undefined) || scoped?.items.at(-1)?.title || status : status;
  return <button ref={element} type="button" className="buzhou-session-window" aria-pressed={selected} onClick={()=>onSelect(session.id)} title={`${displayName(session.title)} · ${displayName(session.projectAlias)}`}>
    <span className="buzhou-session-window__title"><span className={running?'buzhou-session-dot buzhou-session-dot--running':'buzhou-session-dot'}/><strong>{displayName(session.title)}</strong><small>{session.provider==='claude'?'Claude':'Codex'}</small></span>
    <span className="buzhou-session-window__project">{displayName(session.projectAlias)} · {status}</span>
    <span className="buzhou-session-window__preview"><Terminal size={12}/><span>{displayName(preview).replace(/\s+/g,' ').slice(0,180)}</span></span>
  </button>;
}
function SessionRow({kind,sessions,selectedId,online,detail,onSelect}:{kind:'running'|'managed';sessions:FleetSession[];selectedId?:string;online:boolean;detail?:SessionDetail;onSelect:(id:string)=>void}) {
  const track=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({start:true,end:true});
  const ids=sessions.map(s=>s.id).join(',');
  useEffect(()=>{
    const node=track.current;if(!node)return;
    const update=()=>setEdges({start:node.scrollLeft<=1,end:node.scrollLeft+node.clientWidth>=node.scrollWidth-1});
    const observer=new ResizeObserver(update);observer.observe(node);for(const child of node.children)observer.observe(child);
    node.addEventListener('scroll',update,{passive:true});update();return()=>{observer.disconnect();node.removeEventListener('scroll',update);};
  },[ids]);
  useEffect(()=>{const node=track.current;const selected=node?.querySelector<HTMLElement>('[aria-pressed="true"]');if(node&&selected){const a=node.getBoundingClientRect(),b=selected.getBoundingClientRect();if(b.left<a.left)node.scrollLeft+=b.left-a.left;else if(b.right>a.right)node.scrollLeft+=b.right-a.right;}},[selectedId,ids]);
  const label=kind==='running'?t('正在运行'):t('已接管');
  const scroll=(direction:number)=>track.current?.scrollBy({left:direction*track.current.clientWidth*.8,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  return <section className="buzhou-session-row" aria-label={label}>
    <div className="buzhou-session-row__label">{kind==='running'?<Activity size={14}/>:<Layers3 size={14}/>}<span>{label}<small>{sessions.length}</small></span></div>
    <button className="buzhou-session-arrow" type="button" disabled={edges.start} aria-label={t('向左查看更多会话')} onClick={()=>scroll(-1)}><ChevronLeft size={15}/></button>
    <div ref={track} className="buzhou-session-track">{sessions.length?sessions.map(session=><SessionWindow key={`${session.id}:${session.contentEpoch}:${session.activeTurnId??'idle'}`} session={session} running={kind==='running'} selected={session.id===selectedId} online={online} detail={detail} onSelect={onSelect}/>):<p>{kind==='running'?t('暂无运行会话'):t('暂无已接管会话')}</p>}</div>
    <button className="buzhou-session-arrow" type="button" disabled={edges.end} aria-label={t('向右查看更多会话')} onClick={()=>scroll(1)}><ChevronRight size={15}/></button>
  </section>;
}
export function BuzhoushanSessions({enabled,machine,sessions,selectedId,detail,onSelect,onBrowse,onCreate,children}:{enabled:boolean;machine?:Machine;sessions:FleetSession[];selectedId?:string;detail?:SessionDetail;onSelect:(id:string)=>void;onBrowse:()=>void;onCreate:()=>void;children:ReactNode}) {
  const [expandedFor,setExpandedFor]=useState<string>();
  const [picked,setPicked]=useState<{machineId?:string;id:string}>();
  useEffect(()=>{setPicked(undefined);setExpandedFor(undefined);},[machine?.id]);
  const scope=JSON.stringify([machine?.id,selectedId]);
  if(!enabled)return <>{children}</>;
  const groups=hostSessionGroups(sessions,machine);
  const showSwitcher=!selectedId || expandedFor===scope;
  const select=(id:string)=>{setPicked({machineId:machine?.id,id});setExpandedFor(undefined);onSelect(id);};
  return <div className="buzhou-editor">
    {selectedId && <div className="buzhou-session-toggle"><button type="button" aria-controls="buzhou-session-picker" aria-expanded={showSwitcher} onClick={()=>setExpandedFor(showSwitcher?undefined:scope)}><Layers3 size={13}/>{showSwitcher?t('收起会话选择'):t('切换会话')}</button></div>}
    {showSwitcher && <div id="buzhou-session-picker" className="buzhou-session-switcher" aria-label={t('当前主机会话切换')}>
      {(['running','managed'] as const).map(kind=><SessionRow key={`${machine?.id}:${kind}`} kind={kind} sessions={groups[kind]} selectedId={picked?.machineId===machine?.id && picked?.id===selectedId ? selectedId : undefined} online={machine?.reachability==='live'} detail={detail} onSelect={select}/>)}
      {!groups.running.length&&!groups.managed.length&&<div className="buzhou-session-empty-actions"><button type="button" onClick={onBrowse}>{t('展开项目与会话')}</button><button type="button" onClick={onCreate} disabled={!machine||machine.reachability!=='live'}>{t('新会话')}</button></div>}
    </div>}
    {children}
  </div>;
}
