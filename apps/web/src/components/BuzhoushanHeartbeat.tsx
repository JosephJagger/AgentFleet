import {Heart} from 'lucide-react';
import {useEffect,useState} from 'react';
import type {SessionDetail, TimelineEvent} from '../lib/types';
import {buzhoushanReplyState} from '../lib/buzhoushan-stream';
import {t} from '../i18n';

export function BuzhoushanHeartbeat({detail, messages}:{detail:SessionDetail;messages:TimelineEvent[]}) {
  const session=detail.session;
  const reply=buzhoushanReplyState(detail,messages);
  const running=(Boolean(session.activeTurnId)||session.state.currentTurn==='in_progress') && session.state.reachability==='live' && !session.state.unknownFreeze && detail.hostOnline!==false && !reply.ended;
  const [settled,setSettled]=useState<string>();
  useEffect(()=>{
    if(!running || !reply.completionKey || reply.open) {setSettled(undefined);return;}
    const timer=window.setTimeout(()=>setSettled(reply.completionKey),1000);
    return ()=>window.clearTimeout(timer);
  },[running,reply.completionKey,reply.open]);
  if(!running)return null;
  // A pause or an interleaved tool event never completes a streaming message.
  const heartbeat=!reply.open && (!reply.hasReply || Boolean(reply.processAfter && settled===reply.completionKey));
  const label=session.state.waitReason==='approval'?t('等待确认'):session.state.waitReason==='user_input'?t('等待回答'):t('正在执行，过程见终端');
  const quietLabel=reply.open?t('正在回复'):t('回复已完成，等待后续进度');
  return <div className="buzhou-heartbeat" data-mode={heartbeat?'heartbeat':reply.open?'reply':'settling'} role="status" aria-label={heartbeat?label:quietLabel}>
    <div className="buzhou-heartbeat__layer buzhou-heartbeat__pulse" aria-hidden={!heartbeat}>
      <div className="buzhou-heartbeat__visual" aria-hidden="true">
        <svg viewBox="0 0 800 140" preserveAspectRatio="none"><path d="M0 70H110L130 58L145 82L164 70H240L264 70L280 30L296 112L316 54L334 70H470L494 70L510 30L526 112L546 54L564 70H800"/></svg>
        <Heart className="buzhou-heartbeat__heart" size={100} strokeWidth={1.5}/>
      </div>
      <strong>{label}</strong><small>{t('等待新的对话消息')}</small>
    </div>
    <div className="buzhou-heartbeat__layer buzhou-heartbeat__reply" aria-hidden={heartbeat}><small>{quietLabel}</small></div>
  </div>;
}
