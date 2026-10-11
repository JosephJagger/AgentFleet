import {Heart} from 'lucide-react';
import type {SessionDetail, TimelineEvent} from '../lib/types';
import {t} from '../i18n';

export function BuzhoushanHeartbeat({detail, messages}:{detail:SessionDetail;messages:TimelineEvent[]}) {
  const session=detail.session;
  const running=(Boolean(session.activeTurnId)||session.state.currentTurn==='in_progress') && session.state.reachability==='live' && !session.state.unknownFreeze && detail.hostOnline!==false;
  const turn=session.activeTurnId;
  const reply=messages.filter(event=>event.actor==='agent' && event.nativeTurnId===turn && Boolean(event.body)).at(-1);
  const process=detail.events.filter(event=>event.nativeTurnId===turn && (event.type==='turn.started'||event.type==='command_output.delta'||['reasoning','commandExecution','fileChange','plan'].includes(event.itemType??''))).at(-1);
  const ended=Boolean(turn&&detail.events.some(event=>event.nativeTurnId===turn&&['turn.completed','turn.failed','turn.interrupted'].includes(event.type)));
  // Activity-driven, not a silence timeout: reasoning/tools never interrupt the animation.
  if(!running || ended || (reply && (!process || reply.sessionSeq>=process.sessionSeq)))return null;
  const label=session.state.waitReason==='approval'?t('等待确认'):session.state.waitReason==='user_input'?t('等待回答'):t('正在执行，过程见终端');
  return <div className="buzhou-heartbeat" role="status" aria-label={label}>
    <div className="buzhou-heartbeat__visual" aria-hidden="true">
      <svg viewBox="0 0 800 140" preserveAspectRatio="none"><path d="M0 70H110L130 58L145 82L164 70H240L264 70L280 30L296 112L316 54L334 70H470L494 70L510 30L526 112L546 54L564 70H800"/></svg>
      <Heart className="buzhou-heartbeat__heart" size={100} strokeWidth={1.5}/>
    </div>
    <strong>{label}</strong>
    <small>{t('等待新的对话消息')}</small>
  </div>;
}
