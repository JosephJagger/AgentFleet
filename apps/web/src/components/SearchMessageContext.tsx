import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { FleetSession, TimelineEvent } from '../lib/types';
import { timelineItems } from '../lib/timeline-items';
import { t } from '../i18n';
import { ConversationViewport } from './ConversationViewport';
import './search-message-context.css';

type Context = Awaited<ReturnType<typeof api.searchContext>>;
export function SearchMessageContext({session,eventId,onReturnToLatest,renderEvents}:{
  session:FleetSession;eventId:string;onReturnToLatest:()=>void;renderEvents:(events:TimelineEvent[], targetId:string)=>ReactNode;
}) {
  const [page,setPage]=useState<Context>(),[busy,setBusy]=useState(true),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const controller=useRef<AbortController | undefined>(undefined);
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;setPage(undefined);setBusy(true);setError(false);
    void api.searchContext(session.id,eventId,abort.signal).then(value=>{
      if(abort.signal.aborted)return;
      if(value.projectionEpoch!==session.projectionEpoch||value.contentEpoch!==session.contentEpoch)throw new Error('History changed');
      setPage(value);
    }).catch(()=>{if(!abort.signal.aborted)setError(true);}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});
    return()=>abort.abort();
  },[session.id,eventId,session.projectionEpoch,session.contentEpoch,attempt]);
  const events=useMemo(()=>timelineItems(page?.events??[]),[page]);
  const source=page?.events.find(event=>event.id===eventId);
  const target=source&&events.find(event=>event.sessionSeq===source.sessionSeq&&event.payloadState==='present');
  const found=Boolean(target);
  async function more(direction:'before'|'after') {
    if(!page||busy)return;
    const abort=controller.current!;setBusy(true);setError(false);
    try {
      const next=direction==='before'
        ? await api.history(session.id,page.nextBeforeSeq,abort.signal)
        : await api.historyForward(session.id,page.nextAfterSeq!,page.projectionEpoch,page.contentEpoch,abort.signal);
      if(abort.signal.aborted)return;
      if('projectionEpoch' in next&&(next.projectionEpoch!==page.projectionEpoch||next.contentEpoch!==page.contentEpoch))throw new Error('History changed');
      setPage(current=>current?{...current,events:[...new Map([...current.events,...next.events].map(event=>[event.id,event])).values()].sort((a,b)=>a.sessionSeq-b.sessionSeq),
        ...(direction==='before'&&'nextBeforeSeq' in next?{nextBeforeSeq:next.nextBeforeSeq}:{}),
        ...(direction==='after'&&'nextAfterSeq' in next?{nextAfterSeq:next.nextAfterSeq}:{})}:current);
    }catch{if(!abort.signal.aborted)setError(true);}finally{if(!abort.signal.aborted)setBusy(false);}
  }
  return <section className="search-message-context" aria-label={t('正文命中')}>
    <div className="search-context-bar"><strong>{busy?t('正在定位消息…'):t('正文命中')}</strong><button type="button" onClick={onReturnToLatest}>{t('回到最新')}</button></div>
    {(error||page&&!found)&&<p role="alert" className="search-context-status">{t('无法定位该消息，正文可能已过期或删除。')} <button type="button" disabled={busy} onClick={()=>setAttempt(n=>n+1)}>{t('重试')}</button></p>}
    {found&&<ConversationViewport events={events} targetEventId={target!.id} onReturnToLatest={onReturnToLatest}>
      {page?.nextBeforeSeq!=null&&<button type="button" className="catalog-more" disabled={busy} onClick={()=>void more('before')}>{t('加载更早记录')}</button>}
      {renderEvents(events,target!.id)}
      {page?.nextAfterSeq!=null&&<button type="button" className="catalog-more" disabled={busy} onClick={()=>void more('after')}>{t('加载后续记录')}</button>}
    </ConversationViewport>}
  </section>;
}
