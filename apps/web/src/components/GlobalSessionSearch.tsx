import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Machine } from '../lib/types';
import { PROVIDER_NAMES, providerName } from '../lib/provider-catalog';
import { locale, systemText, t } from '../i18n';
import './global-session-search.css';

export type SessionSearchItem = {
  id:string; title:string; machineId:string; machineName:string; projectId:string; project:string; path:string;
  provider:string; managed:boolean; online:boolean; state:string; updatedAt:string; contentAvailable:boolean;
  match:'title'|'location'|'message'|'approximate'; snippet:string; messageRole:'user'|'assistant'|null;
};
export type SessionSearchPage = {items:SessionSearchItem[];total:number;nextOffset:number|null;query:string;terms:string[];
  mode:'keyword_fuzzy';contentStatus:'searched'|'short_query'|'not_requested'|'unavailable'};

function Highlight({text,terms}:{text:string;terms:string[]}) {
  if(!terms.length)return <>{text}</>;
  const pattern=new RegExp(`(${[...terms].sort((a,b)=>b.length-a.length).map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})`,'giu');
  return <>{text.split(pattern).map((part,index)=>index%2?<mark key={index}>{part}</mark>:part)}</>;
}

export function GlobalSessionSearch({machines,initialQuery='',onClose,onSelect}:{machines:Machine[];initialQuery?:string;onClose:()=>void;onSelect:(item:SessionSearchItem)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null);
  const [query,setQuery]=useState(initialQuery),[machine,setMachine]=useState(''),[provider,setProvider]=useState(''),[managed,setManaged]=useState(false);
  const [offset,setOffset]=useState(0),[retry,setRetry]=useState(0),[composing,setComposing]=useState(false);
  const [result,setResult]=useState<{key:string;page:SessionSearchPage}>(),[loading,setLoading]=useState(true),[error,setError]=useState(''),[active,setActive]=useState(0);
  const scope=JSON.stringify([query.trim(),machine,provider,managed]);
  const current=result?.key===scope?result.page:undefined;
  useEffect(()=>{const node=dialog.current!;node.showModal();input.current?.focus();return()=>node.close();},[]);
  useEffect(()=>{
    const controller=new AbortController();
    setError('');setLoading(true);
    if(composing)return()=>controller.abort();
    const timer=window.setTimeout(()=>{
      void api.searchSessions({q:query.trim(),...(machine?{machineId:machine}:{}),...(provider?{provider}:{}),...(managed?{managed:true}:{}),offset},controller.signal)
        .then(page=>{if(controller.signal.aborted)return;setResult(previous=>({key:scope,page:{...page,items:offset&&previous?.key===scope?[...new Map([...previous.page.items,...page.items].map(item=>[item.id,item])).values()]:page.items}}));})
        .catch(reason=>{if(!controller.signal.aborted)setError(reason.message);})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    },query.trim()?300:0);
    return()=>{window.clearTimeout(timer);controller.abort();};
  },[scope,offset,retry,composing]);
  useEffect(()=>{dialog.current?.querySelector(`[data-result-index="${active}"]`)?.scrollIntoView?.({block:'nearest'});},[active]);
  function reset(){setOffset(0);setActive(0);}
  function select(item:SessionSearchItem){onSelect(item);onClose();}
  return <dialog ref={dialog} className="global-session-search" aria-labelledby="global-search-title" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===dialog.current){const box=dialog.current.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose();}}}>
    <header className="global-search-header"><div><h2 id="global-search-title">{t('全局会话搜索')}</h2><p>{t('跨主机、跨项目，找到之前的任务')}</p></div><button type="button" className="global-search-close" aria-label={t('关闭搜索')} onClick={onClose}><X size={20}/></button></header>
    <div className="global-search-query"><Search size={21}/><input ref={input} type="search" value={query} maxLength={160} aria-label={t('搜索全部会话')} placeholder={t('搜索会话标题、提问或回复…')} aria-controls="global-search-results" role="combobox" aria-expanded={Boolean(current?.items.length)} aria-autocomplete="list" aria-activedescendant={current?.items[active]?`global-result-${current.items[active].id}`:undefined}
      onChange={event=>{setQuery(event.target.value);reset();}} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onKeyDown={event=>{
        if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229||composing)return;
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(0,Math.min((current?.items.length??1)-1,index+(event.key==='ArrowDown'?1:-1))));}
        if(event.key==='Enter'&&current?.items[active]){event.preventDefault();select(current.items[active]);}
      }}/>{loading&&<LoaderCircle className="spin" size={18} aria-label={t('搜索中…')}/>}</div>
    <div className="global-search-filters"><select aria-label={t('搜索范围：主机')} value={machine} onChange={event=>{setMachine(event.target.value);reset();}}><option value="">{t('全部主机')}</option>{machines.map(host=><option key={host.id} value={host.id}>{host.name}</option>)}</select>
      <select aria-label={t('搜索范围：智能体')} value={provider} onChange={event=>{setProvider(event.target.value);reset();}}><option value="">{t('全部智能体')}</option>{Object.entries(PROVIDER_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      <label><input type="checkbox" checked={managed} onChange={event=>{setManaged(event.target.checked);reset();}}/>{t('仅已接管')}</label></div>
    <div className="global-search-status" role="status" aria-live="polite">{error?t('搜索未完成'):loading?t('搜索中…'):query.trim()?t('找到 {0} 个会话',current?.total??0):t('最近活跃的会话')}
      <span>{t('关键词 · 标题模糊匹配')}</span></div>
    {current?.contentStatus==='unavailable'&&<p className="global-search-notice" role="alert">{t('正文搜索暂未完成，当前显示标题和项目匹配。')}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('重试')}</button></p>}
    {current?.contentStatus==='short_query'&&<p className="global-search-notice">{t('输入至少 2 个字符，可同时搜索已同步的正文。')}</p>}
    {error&&<p className="global-search-notice" role="alert">{systemText(error)}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('重试')}</button></p>}
    <div className="global-search-results" id="global-search-results" role="listbox" aria-label={t('会话搜索结果')} aria-busy={loading}>
      {current?.items.map((item,index)=><button type="button" role="option" aria-selected={index===active} tabIndex={-1} id={`global-result-${item.id}`} data-result-index={index} key={item.id} className="global-search-result" onPointerMove={()=>setActive(index)} onClick={()=>select(item)}>
        <span className="global-search-result-top"><strong><Highlight text={item.title} terms={current.terms}/></strong><ArrowUpRight size={17}/></span>
        <span className="global-search-location"><Highlight text={`${item.machineName} · ${providerName(item.provider)} · ${item.project}`} terms={current.terms}/></span>
        {item.snippet&&<span className="global-search-snippet"><span>{item.messageRole==='user'?t('你'):providerName(item.provider)} · </span><Highlight text={item.snippet} terms={current.terms}/></span>}
        <span className="global-search-result-meta"><span>{item.match==='message'?t('正文命中'):query.trim()?item.match==='approximate'?t('相近标题'):item.match==='title'?t('标题命中'):t('主机或项目命中'):item.managed?t('已接管'):t('未接管')}{!item.online&&` · ${t('离线')}`}{!item.contentAvailable&&` · ${t('仅标题与项目可搜')}`}</span><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString(locale(),{month:'short',day:'numeric'})}</time></span>
        <span className="global-search-path" title={item.path}>{item.path}</span>
      </button>)}
      {!loading&&!error&&!current?.items.length&&<div className="global-search-empty"><Search size={28}/><strong>{query.trim()?t('没有找到匹配的会话'):t('暂无会话')}</strong><p>{t('试试任务中的几个关键词，或取消主机和智能体筛选。')}</p></div>}
    </div>
    {current?.nextOffset!==null&&current?.nextOffset!==undefined&&<button type="button" className="global-search-more" disabled={loading} onClick={()=>setOffset(current.nextOffset!)}>{loading?t('搜索中…'):t('加载更多会话')}</button>}
    <footer className="global-search-footer"><span>{t('正文仅搜索已同步且未过期的提问和回复。')}</span><span className="global-search-keys">↑ ↓ {t('选择')} · Enter {t('打开')} · Esc {t('关闭')}</span></footer>
  </dialog>;
}
