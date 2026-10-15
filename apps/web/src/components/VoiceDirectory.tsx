import {useEffect,useState} from 'react';
import {api,type VoiceDirectoryPage} from '../lib/api';
import {displayName} from '../lib/display-name';
import {t} from '../i18n';

export function VoiceDirectory({onOpenSession}:{onOpenSession:(id:string)=>void}) {
 const [open,setOpen]=useState(false),[status,setStatus]=useState('active'),[provider,setProvider]=useState(''),[query,setQuery]=useState(''),[host,setHost]=useState(''),[project,setProject]=useState(''),[sessionName,setSessionName]=useState('');
 const [page,setPage]=useState<VoiceDirectoryPage|null>(null),[cursor,setCursor]=useState(''),[refresh,setRefresh]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 useEffect(()=>{setCursor('');setPage(null);},[status,provider,query,host,project,sessionName]);
 useEffect(()=>{
  if(!open)return;
  let stopped=false,generation=0;let controller:AbortController|undefined;
  const read=async()=>{
   if(document.visibilityState==='hidden')return;
   const version=++generation;controller?.abort();controller=new AbortController();setLoading(true);
   try{const result=await api.voiceDirectory({directoryStatus:status,provider,query,host,project,sessionName,cursor},controller.signal);if(!stopped&&version===generation){setPage(result);setError('');}}
   catch(e){if(!stopped&&version===generation&&!controller.signal.aborted)setError(e instanceof Error?e.message:t('目录读取失败'));}
   finally{if(!stopped&&version===generation)setLoading(false);}
  };
  const timer=setTimeout(read,300),poll=setInterval(read,15000);
  const visible=()=>{if(document.visibilityState==='hidden'){generation++;controller?.abort();}else void read();};
  document.addEventListener('visibilitychange',visible);
  return()=>{stopped=true;controller?.abort();clearTimeout(timer);clearInterval(poll);document.removeEventListener('visibilitychange',visible);};
 },[open,status,provider,query,host,project,sessionName,cursor,refresh]);
 return <details className="voice-directory" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary>{t('主机与会话目录')}</summary>
  {open&&<div className="voice-directory__body">
   <div className="voice-directory__filters">
    <label>{t('状态')}<select value={status} onChange={e=>setStatus(e.target.value)}><option value="active">{t('已接管及运行中')}</option><option value="running">{t('运行中')}</option><option value="managed">{t('已接管')}</option><option value="online">{t('在线主机的会话')}</option><option value="all">{t('全部授权会话')}</option></select></label>
    <label>Provider<select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">{t('全部')}</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
   </div>
   <input aria-label={t('组合搜索')} placeholder={t('主机 项目 会话，空格组合搜索')} value={query} onChange={e=>setQuery(e.target.value)}/>
   <details><summary>{t('按名称缩小范围')}</summary><div className="voice-directory__filters">
    <label>{t('主机')}<input value={host} onChange={e=>setHost(e.target.value)}/></label>
    <label>{t('项目')}<input value={project} onChange={e=>setProject(e.target.value)}/></label>
    <label>{t('会话')}<input value={sessionName} onChange={e=>setSessionName(e.target.value)}/></label>
   </div></details>
   <div className="voice-directory__refresh"><button className="button button--secondary" type="button" onClick={()=>{setCursor('');setRefresh(v=>v+1);}}>{t('刷新目录')}</button><small>{loading?t('读取中…'):page?`${t('更新于')} ${new Date(page.generatedAt).toLocaleTimeString()}`:''}</small></div>
   {error&&<p role="alert">{t('目录可能已过期，请刷新后核实。')} {error}</p>}
   {page&&<>
    <p className="panel-voice-control__hint">{t('在线主机')} {page.hostTotal} · {page.hosts.map(h=>displayName(h.name)).join(' · ')}{page.hostsTruncated?' …':''}</p>
    <p className="panel-voice-control__hint">{t('匹配会话')} {page.total} · {t('状态来自主机上报，目录不代表执行授权。')}</p>
    {!page.sessions.length&&<p>{t('没有匹配会话，请调整筛选。')}</p>}
    <div className="voice-directory__list">{page.sessions.map(s=><button key={s.id} type="button" disabled={Boolean(error)||loading} onClick={()=>onOpenSession(s.id)} title={`${s.id}\n${t('主机心跳')} ${s.hostHeartbeatAt??'—'}\n${t('会话更新')} ${s.sessionUpdatedAt}`}>
     <strong>{displayName(s.title)}</strong><span>{displayName(s.host)} · {displayName(s.project)} · {s.provider==='claude'?'Claude Code':'Codex'}</span>
     <small>{s.freshness==='live'?t('状态已同步'):t('状态待同步')} · {s.managed?t('已接管'):t('未接管')} · {s.executionState==='running'?t('运行中'):s.executionState==='idle'?t('空闲'):s.executionState}</small>
    </button>)}</div>
    {page.nextCursor&&<button type="button" className="button button--secondary" disabled={loading||Boolean(error)} onClick={()=>setCursor(page.nextCursor!)}>{t('下一页')}</button>}
   </>}
   <p className="panel-voice-control__hint">{t('展开时每 15 秒刷新；只读取目录，不加载会话正文。')}</p>
  </div>}
 </details>;
}
