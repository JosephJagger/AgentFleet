import type { SessionDetail, TimelineEvent } from './types';
/** Classify native types, never translated titles or text contents. */
export function isConversationEvent(event: TimelineEvent): boolean {
  if (event.itemType) return event.itemType === 'userMessage' || event.itemType === 'agentMessage';
  return (event.actor === 'user' || event.actor === 'agent') && !event.command && !event.diff && !event.fileChanges?.length && (event.type === 'message' || event.type === 'agent_message.delta');
}

/** Keep the turn outcome in chat as well as the activity record. */
export function isBuzhoushanChatEvent(event: TimelineEvent): boolean {
  return isConversationEvent(event) || ['turn.completed','turn.failed','turn.interrupted','turn.cancelled'].includes(event.type);
}

/** A reply/item completion is not the end of a turn. */
export function isBuzhoushanTurnActive(detail: SessionDetail): boolean {
  const {session} = detail;
  if (session.activeTurnId && detail.events.some(event => event.nativeTurnId === session.activeTurnId && ['turn.completed','turn.failed','turn.interrupted','turn.cancelled'].includes(event.type))) return false;
  return Boolean(session.activeTurnId) || session.state.currentTurn === 'in_progress';
}
