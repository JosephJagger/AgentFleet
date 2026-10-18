import type { SessionDetail, TimelineEvent } from './types';
/** Classify native types, never translated titles or text contents. */
export function isConversationEvent(event: TimelineEvent): boolean {
  if (event.itemType) return event.itemType === 'userMessage' || event.itemType === 'agentMessage';
  return (event.actor === 'user' || event.actor === 'agent') && !event.command && !event.diff && !event.fileChanges?.length && (event.type === 'message' || event.type === 'agent_message.delta');
}

/** Keep the turn outcome in chat as well as the activity record. */
export function isBuzhoushanChatEvent(event: TimelineEvent): boolean {
  return isConversationEvent(event) || ['turn.completed','turn.failed','turn.interrupted','turn.cancelled'].includes(event.type)
    || (event.type === 'command.result' && ['failed','unknown'].includes(event.status ?? ''));
}

/** A reply/item completion is not the end of a turn. */
export function isBuzhoushanTurnActive(detail: SessionDetail): boolean {
  const {session} = detail;
  const terminal = ['turn.completed','turn.failed','turn.interrupted','turn.cancelled'];
  const lifecycle = session.activeTurnId ? detail.events
    .filter(event => event.nativeTurnId === session.activeTurnId && (event.type === 'turn.started' || terminal.includes(event.type)))
    .sort((a,b) => a.sessionSeq - b.sessionSeq).at(-1) : undefined;
  if (lifecycle && terminal.includes(lifecycle.type)) return false;
  // Explicit turn outcome wins over a stale activeTurnId. Connectivity is not
  // an outcome: reconciling/offline must not reveal interim replies as finished.
  if (['completed','failed','interrupted'].includes(session.state.currentTurn)) return false;
  return Boolean(session.activeTurnId) || session.state.currentTurn === 'in_progress';
}
