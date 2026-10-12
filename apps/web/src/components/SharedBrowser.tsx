import { useEffect, useRef, useState } from 'react';
import { Globe, Hand, Play, RefreshCw } from 'lucide-react';
import { collaborationApi } from '../lib/api';
import type { FleetSession } from '../lib/types';
import type { BrowserFrame } from '../lib/collaboration';
import { displayName } from '../lib/display-name';
import { t, systemText } from '../i18n';

type Phase = 'checking'|'closed'|'opening'|'open'|'unknown'|'failed';
const message = (error:unknown) => error instanceof Error ? systemText(error.message) : t('浏览器状态暂未确认');
const validFrame = (frame:BrowserFrame) => Boolean(frame && typeof frame.image==='string' && frame.image.startsWith('data:image/') && Number.isFinite(frame.revision));

export function SharedBrowser({session}:{session:FleetSession}) {
  const [frame,setFrame]=useState<BrowserFrame|null>(null),[phase,setPhase]=useState<Phase>('checking');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState('https://'),[input,setInput]=useState('');
  const [refreshKey,setRefreshKey]=useState(0);
  const generation=useRef(0),operation=useRef(false),reads=useRef<AbortController|null>(null),actionAbort=useRef<AbortController|null>(null);
  const recoveryUntil=useRef(0),pageUrl=useRef(''),recoveringError=useRef(false);
  const opened=frame!==null, controlsBusy=busy||phase!=='open';
  const applyFrame=(value:BrowserFrame)=>{
    if(!validFrame(value))throw new Error(t('浏览器返回了无效预览，请重新检查'));
    setFrame(value);setPhase('open');recoveryUntil.current=0;if(recoveringError.current){setError('');recoveringError.current=false;}
    if(pageUrl.current!==value.url){pageUrl.current=value.url;setUrl(/^https?:/.test(value.url)?value.url:'https://');}
  };
  // The host owns the browser. Mounting or reconnecting only reads its state.
  useEffect(()=>{
    generation.current++;operation.current=false;setFrame(null);setPhase('checking');setBusy(false);setError('');setInput('');setUrl('https://');pageUrl.current='';recoveryUntil.current=0;
    return()=>{generation.current++;reads.current?.abort();actionAbort.current?.abort();};
  },[session.id]);
  useEffect(()=>{
    const controller=new AbortController();reads.current=controller;
    const current=generation.current;let timer:ReturnType<typeof setTimeout>|undefined;
    const alive=()=>!controller.signal.aborted&&current===generation.current;
    const later=(delay:number)=>{if(alive())timer=setTimeout(()=>void poll(),delay);};
    const poll=async()=>{
      if(operation.current){later(500);return;}
      try {
        const status=await collaborationApi.browserStatus(session.id,controller.signal);
        if(!alive())return;
        if(status.state==='open') {
          const value=await collaborationApi.browser(session.id,{action:'snapshot'},controller.signal);
          if(!alive())return;applyFrame(value);later(2000);
        } else if(status.state==='opening') {
          recoveryUntil.current ||= Date.now()+60000;
          if(Date.now()>=recoveryUntil.current){setPhase('unknown');setError(t('启动结果仍未确认，请重新检查；不会自动再次启动。'));return;}
          setPhase('opening');later(1500);
        } else if(status.state==='closed'||status.state==='failed') {
          setFrame(null);setPhase(status.state);recoveryUntil.current=0;
          if(status.state==='failed')setError(status.error?systemText(status.error):t('浏览器启动失败，请检查主机浏览器后重试。'));
        } else throw new Error(t('主机尚不支持浏览器状态恢复，请检查并更新连接服务。'));
      } catch(reason) {if(alive()){setPhase('unknown');setError(message(reason));recoveringError.current=true;}}
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[session.id,refreshKey]);
  function recheck(){reads.current?.abort();setError('');setPhase('checking');recoveryUntil.current=Date.now()+60000;setRefreshKey(key=>key+1);}
  async function act(action:string,extra:Record<string,unknown>={}){
    if(operation.current)return;operation.current=true;reads.current?.abort();setBusy(true);setError('');setPhase(action==='open'?'opening':'checking');
    const current=generation.current,controller=new AbortController();actionAbort.current=controller;
    const alive=()=>current===generation.current&&!controller.signal.aborted;
    try {
      const value=await collaborationApi.browser(session.id,{action,key:crypto.randomUUID(),revision:frame?.revision,...extra},controller.signal);
      if(!alive())return;
      if(action==='close'){setFrame(null);setPhase('closed');pageUrl.current='';setUrl('https://');}
      else if(action==='open')applyFrame(value);
      return true;
    } catch(reason) {
      if(alive()){setPhase('checking');setError(message(reason));recoveringError.current=action==='open';recoveryUntil.current=Date.now()+60000;}
    } finally {
      if(alive()){operation.current=false;setBusy(false);setRefreshKey(key=>key+1);}
    }
  }
  return <div className="collaboration-browser">
    <p className="collaboration-location">{t('浏览器位于')}：<strong>{displayName(session.machineName??'')}</strong></p>
    {error&&<p role="alert" className="collaboration-error">{error}</p>}
    {['checking','opening','unknown'].includes(phase)&&<div className="collaboration-browser-status" role="status"><strong>{phase==='opening'?t('正在启动共享浏览器'):phase==='checking'?t('正在检查浏览器状态'):t('浏览器状态暂未确认')}</strong><p>{opened?t('保留上次预览，连接恢复前暂停网页操作。'):t('这里只显示当前会话的共享浏览器，不会同步其他浏览器窗口。')}</p>{phase==='unknown'&&<button type="button" disabled={busy} onClick={recheck}>{t('重新检查')}</button>}</div>}
    {!opened?<div className="collaboration-welcome"><Globe size={34}/><h3>{t('一起看网页，一起把事情做完')}</h3><p>{t('先打开共享浏览器，再点击“交给 AI”。从下一轮对话开始，让助手使用共享浏览器，操作前会等待你确认。')}</p><button type="button" className="button button--primary" disabled={busy||!['closed','failed'].includes(phase)||session.state.ownership!=='agentfleet_owned'} onClick={()=>void act('open')}>{phase==='opening'?t('正在打开…'):t('打开浏览器协作')}</button><small>{t('需要主机安装新版连接服务及 Chrome、Edge 或 Chromium。打开后，从下一轮对话开始使用。')}</small></div>:<>
      <form className="collaboration-address" onSubmit={e=>{e.preventDefault();void act('navigate',{url});}}><input aria-label={t('网页地址')} type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com" disabled={controlsBusy||frame?.mode!=='human'}/><button type="submit" disabled={controlsBusy||frame?.mode!=='human'}>{t('打开')}</button></form>
      <div className="collaboration-browser-controls"><span>{frame?.mode==='agent'?t('AI 可查看 · 操作需确认'):t('由你操作')}</span><button type="button" disabled={controlsBusy} onClick={()=>void act(frame?.mode==='agent'?'takeover':'handoff')}>{frame?.mode==='agent'?<Hand size={15}/>:<Play size={15}/>} {frame?.mode==='agent'?t('我来操作'):t('交给 AI')}</button><button type="button" disabled={controlsBusy} aria-label={t('刷新网页预览')} onClick={recheck}><RefreshCw size={15}/></button><button type="button" disabled={controlsBusy} onClick={()=>void act('close')}>{t('关闭浏览器')}</button></div>
      {frame?.pending&&<div className="collaboration-approval" role="status"><strong>{t('AI 想执行这一步，请你确认')}</strong><p>{({navigate:t('打开网页'),click:t('点击页面'),fill:t('填写内容'),key:t('按键操作'),scroll:t('滚动页面')} as Record<string,string>)[frame.pending.action.action]}</p><code>{displayName(frame.pending.action.url??frame.pending.action.selector??(frame.pending.action.x!==undefined?`(${frame.pending.action.x}, ${frame.pending.action.y})`:''))}</code>{frame.pending.action.text&&<pre>{frame.pending.action.text}</pre>}<div><button type="button" disabled={controlsBusy} onClick={()=>void act('approve',{pendingId:frame.pending!.id})}>{t('允许这一步')}</button><button type="button" disabled={controlsBusy} onClick={()=>void act('deny',{pendingId:frame.pending!.id})}>{t('拒绝')}</button></div></div>}
      {frame&&<><p className="collaboration-page-title" title={frame.url}>{frame.title||frame.url}</p><button type="button" className="collaboration-preview" aria-label={t('网页预览，点击页面位置操作')} disabled={controlsBusy||frame.mode!=='human'} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();void act('click',{x:Math.round((e.clientX-r.left)/r.width*frame.width),y:Math.round((e.clientY-r.top)/r.height*frame.height)});}}><img src={frame.image} alt={t('所选主机上的实时网页预览')} draggable={false}/></button></>}
      <form className="collaboration-address" onSubmit={e=>{e.preventDefault();void act('fill',{text:input}).then(ok=>{if(ok)setInput('');});}}><input type="password" autoComplete="off" aria-label={t('输入到网页当前选中位置')} placeholder={t('先点击网页输入框，再在这里输入')} value={input} onChange={e=>setInput(e.target.value)} disabled={controlsBusy||frame?.mode!=='human'}/><button disabled={controlsBusy||frame?.mode!=='human'||!input} type="submit">{t('输入')}</button></form>
      <div className="collaboration-browser-controls">{['Tab','Enter','Backspace'].map(key=><button type="button" key={key} disabled={controlsBusy||frame?.mode!=='human'} onClick={()=>void act('key',{text:key})}>{key}</button>)}<button type="button" disabled={controlsBusy||frame?.mode!=='human'} onClick={()=>void act('scroll',{delta:-600})}>{t('向上')}</button><button type="button" disabled={controlsBusy||frame?.mode!=='human'} onClick={()=>void act('scroll',{delta:600})}>{t('向下')}</button></div>
      <small>{t('页面预览约每两秒更新。面板超过三十秒未连接时暂停 AI 网页操作；浏览器闲置十分钟关闭。')}</small>
    </>}
  </div>;
}
