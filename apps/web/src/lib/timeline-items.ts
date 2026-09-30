import type { TimelineEvent } from "./types";
import type { TokenCounts } from "./usage";

const usageKeys: (keyof TokenCounts)[] = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"];
const addUsage = (left: TokenCounts | undefined, right: TokenCounts): TokenCounts => Object.fromEntries(
  usageKeys.map((key) => [key, (left?.[key] ?? 0) + right[key]]),
) as unknown as TokenCounts;
const subtractUsage = (current: TokenCounts, previous: TokenCounts): TokenCounts => Object.fromEntries(
  usageKeys.map((key) => [key, current[key] - previous[key]]),
) as unknown as TokenCounts;

/** Project native item lifecycle events into one visible item, without changing the event log. */
export function timelineItems(events: TimelineEvent[]): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  const historyOrder=new Map<string,{index:number;occurredAt?:string}>();
  for(const event of events) for(const item of event.historyOrder ?? []) historyOrder.set(JSON.stringify([event.nativeThreadId,item.itemId]),item);
  const positions = new Map<string, number>();
  const usageByTurn = new Map<string, TokenCounts>();
  const cumulativeByScope = new Map<string, TokenCounts>();
  for (const event of [...events].sort((left, right) => left.sessionSeq - right.sessionSeq)) {
    if (event.type !== "thread.usage" || !event.nativeUsage || !event.nativeTurnId) continue;
    const scope = event.nativeThreadId || event.executionSegmentId;
    if (!scope) continue;
    const previousTotal = cumulativeByScope.get(scope);
    const counterReset = previousTotal && usageKeys.some((key) => event.nativeUsage!.total[key] < previousTotal[key]);
    const increment = !previousTotal || counterReset
      ? event.nativeUsage.last
      : subtractUsage(event.nativeUsage.total, previousTotal);
    cumulativeByScope.set(scope, event.nativeUsage.total);
    if (increment.totalTokens > 0) {
      const key = JSON.stringify([scope, event.nativeTurnId]);
      usageByTurn.set(key, addUsage(usageByTurn.get(key), increment));
    }
  }
  for (const original of events) {
    if (original.type === "thread.usage" || original.type === "thread.history.order") continue;
    const metadata=historyOrder.get(JSON.stringify([original.nativeThreadId,original.nativeItemId]));
    const event=metadata?.occurredAt ? {...original,occurredAt:metadata.occurredAt} : original;
    const scope = event.nativeThreadId || event.executionSegmentId;
    if (event.type === "turn.completed") {
      const usage = scope && event.nativeTurnId ? usageByTurn.get(JSON.stringify([scope, event.nativeTurnId])) : undefined;
      result.push({
        ...event,
        turnTokens: usage?.totalTokens ?? null,
        turnCacheHitRate: usage && usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens * 100 : null,
      });
      continue;
    }
    if (!["item.started", "item.completed"].includes(event.type) || !scope || !event.nativeTurnId || !event.nativeItemId) {
      result.push(event);
      continue;
    }
    const key = `native-item:${JSON.stringify([scope, scope.startsWith("claude_") ? null : event.nativeTurnId, event.nativeItemId])}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push({ ...event, id: key });
      continue;
    }
    const previous = result[position]!;
    // Never resurrect deleted content from an earlier lifecycle event.
    const selected = previous.payloadState === "deleted" ? previous : event.payloadState === "deleted" ? event
      : previous.type === "item.completed" && event.type === "item.started" ? previous
      : event.type === "item.completed" && previous.type === "item.started" ? event
      : event.sessionSeq >= previous.sessionSeq ? event : previous;
    result[position] = { ...selected, id: key };
  }
  // Reorder conversation slots using the native chain, leaving operational events in place.
  const slots=result.map((event,index)=>({event,index})).filter(({event})=>event.nativeThreadId?.startsWith("claude_") && historyOrder.has(JSON.stringify([event.nativeThreadId,event.nativeItemId])));
  const ordered=slots.map(x=>x.event).sort((a,b)=>historyOrder.get(JSON.stringify([a.nativeThreadId,a.nativeItemId]))!.index-historyOrder.get(JSON.stringify([b.nativeThreadId,b.nativeItemId]))!.index);
  slots.forEach((slot,index)=>{result[slot.index]=ordered[index]!;});
  return result;
}
