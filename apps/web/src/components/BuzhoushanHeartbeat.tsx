import {Heart} from 'lucide-react';
import type {SessionDetail, TimelineEvent} from '../lib/types';
import {isBuzhoushanTurnActive} from '../lib/buzhoushan-events';
import {t} from '../i18n';

export function BuzhoushanHeartbeat({detail}:{detail:SessionDetail;messages:TimelineEvent[]}) {
  const session=detail.session;
  const running=isBuzhoushanTurnActive(detail) && session.state.reachability==='live' && !session.state.unknownFreeze && detail.hostOnline!==false;
  if(!running)return null;
  const label=session.state.waitReason==='approval'?t('等待确认'):session.state.waitReason==='user_input'?t('等待回答'):t('对话消息在人机对话查看');
  return <div className="buzhou-heartbeat" data-mode="heartbeat" role="status" aria-label={label}>
    <div className="buzhou-heartbeat__layer buzhou-heartbeat__pulse" aria-hidden={false}>
      <div className="buzhou-heartbeat__visual" aria-hidden="true">
        <svg viewBox="0 0 800 140" preserveAspectRatio="none"><path d="M0 70H110L130 58L145 82L164 70H240L264 70L280 30L296 112L316 54L334 70H470L494 70L510 30L526 112L546 54L564 70H800"/></svg>
        <Heart className="buzhou-heartbeat__heart" size={100} strokeWidth={1.5}/>
      </div>
      <strong>{label}</strong>
    </div>
  </div>;
}
