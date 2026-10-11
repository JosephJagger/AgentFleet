import type { TimelineEvent } from './types';
/** Classify native types, never translated titles or text contents. */
export function isConversationEvent(event: TimelineEvent): boolean {
  if (event.itemType) return event.itemType === 'userMessage' || event.itemType === 'agentMessage';
  return (event.actor === 'user' || event.actor === 'agent') && !event.command && !event.diff && !event.fileChanges?.length && (event.type === 'message' || event.type === 'agent_message.delta');
}
