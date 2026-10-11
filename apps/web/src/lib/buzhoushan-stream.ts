import type {SessionDetail, TimelineEvent} from './types';
const terminal = new Set(['turn.completed','turn.failed','turn.interrupted','turn.cancelled']);
const readable = (e:TimelineEvent) => e.payloadState!=='deleted' && e.payloadState!=='suppressed';
// Explicit native item types take precedence over legacy message envelopes.
const reply = (e:TimelineEvent) => e.itemType ? e.itemType==='agentMessage' : e.actor==='agent' && ['agent_message.delta','message'].includes(e.type);
const identity = (e:TimelineEvent) => e.nativeItemId || e.id;

/** Keep in-flight text through snapshots, only in the desktop workbench. Never cross content epochs. */
export function preserveBuzhoushanStream(previous:SessionDetail|undefined, next:SessionDetail):SessionDetail {
  const turn=next.session.activeTurnId;
  if(!previous || !turn || next.progress?.contentAvailable===false || previous.session.id!==next.session.id || previous.session.activeTurnId!==turn || previous.session.nativeThreadId!==next.session.nativeThreadId || previous.session.contentEpoch!==next.session.contentEpoch || previous.session.projectionEpoch!==next.session.projectionEpoch || previous.session.cloudImageRevision!==next.session.cloudImageRevision || next.events.some(e=>e.nativeTurnId===turn&&terminal.has(e.type))) return next;
  const pending=previous.events.filter(e=>e.type==='agent_message.delta' && e.nativeTurnId===turn && readable(e) && e.nativeItemId && !next.events.some(n=>n.id===e.id || (n.nativeTurnId===turn && n.nativeItemId===e.nativeItemId && (n.type==='item.completed'||!readable(n)))));
  return pending.length ? {...next,events:[...next.events,...pending]} : next;
}

export function buzhoushanReplyState(detail:SessionDetail,messages:TimelineEvent[], knownCompleted:ReadonlySet<string>=new Set()) {
  const turn=detail.session.activeTurnId;
  const events=[...detail.events,...messages].filter(e=>Boolean(turn)&&e.nativeTurnId===turn).sort((a,b)=>a.sessionSeq-b.sessionSeq);
  const ended=events.some(e=>terminal.has(e.type));
  const completed=new Set([...knownCompleted,...events.filter(e=>e.type==='item.completed' && reply(e)).map(identity)]);
  const replies=events.filter(e=>readable(e)&&reply(e)&&Boolean(e.body?.trim()) && (!['agent_message.delta','item.started'].includes(e.type)||!completed.has(identity(e))));
  const open=replies.some(e=>['agent_message.delta','item.started'].includes(e.type)&&!completed.has(identity(e)));
  const last=replies.filter(e=>!['agent_message.delta','item.started'].includes(e.type)||!completed.has(identity(e))).at(-1);
  const finished=last && (last.type==='item.completed'||last.type==='message');
  const completionKey=finished ? JSON.stringify([detail.session.id,detail.session.nativeThreadId,detail.session.contentEpoch,detail.session.projectionEpoch,turn,identity(last)]) : undefined;
  return {ended,open,hasReply:replies.length>0,completionKey,completed};
}
