import {useEffect, useState} from 'react';
import {Heart} from 'lucide-react';
import type {SessionDetail, TimelineEvent} from '../lib/types';
import {t} from '../i18n';

export function BuzhoushanHeartbeat({detail, messages}:{detail:SessionDetail;messages:TimelineEvent[]}) {
  const session=detail.session;
  const running=Boolean(session.activeTurnId) && session.state.currentTurn==='in_progress' && session.state.waitReason==='none' && session.state.reachability==='live' && !session.state.unknownFreeze && detail.hostOnline!==false;
  const latest=messages.filter(event=>event.actor==='agent' && event.nativeTurnId===session.activeTurnId).at(-1);
  const [quiet,setQuiet]=useState(!latest);
  useEffect(()=>{
    setQuiet(!latest);
    if(!running || !latest)return;
    const timer=window.setTimeout(()=>setQuiet(true),10_000);
    return()=>window.clearTimeout(timer);
  },[running,session.id,session.activeTurnId,latest?.id,latest?.body]);
  if(!running || !quiet)return null;
  return <div className="buzhou-heartbeat" role="status" aria-label={t('正在执行，过程见终端')}>
    <div className="buzhou-heartbeat__visual" aria-hidden="true">
      <svg viewBox="0 0 800 140" preserveAspectRatio="none"><path d="M0 70H110L130 58L145 82L164 70H240L264 70L280 30L296 112L316 54L334 70H470L494 70L510 30L526 112L546 54L564 70H800"/></svg>
      <Heart className="buzhou-heartbeat__heart" size={100} strokeWidth={1.5}/>
    </div>
    <strong>{t('正在执行，过程见终端')}</strong>
    <small>{t('等待新的对话消息')}</small>
  </div>;
}
