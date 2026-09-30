export interface TokenCounts { inputTokens:number;outputTokens:number;cachedInputTokens:number;reasoningOutputTokens:number;totalTokens:number }
export interface WeeklyUsageEntry { id:string;title:string;totalTokens:number;inputTokens?:number|null;cachedInputTokens?:number|null }
export interface UsageBreakdownEntry { id:string;title:string;totalTokens:number;weeklyTokens:number|null;weeklyInputTokens:number|null;weeklyCachedInputTokens:number|null }
export interface UsageCredits { balance:string|null;hasCredits:boolean;unlimited:boolean }
export interface ResetPrediction { kind:"temporary-reset"; signal:"announced"|"confirmed"|"card-announced"|"card-confirmed"; expectedAt:string|null; publishedAt:string; evidence:string; observedAt:string; sourceUrl:string }
export interface UsageSummary {
  provider?: "codex" | "claude";
  scope:"session"|"project"|"machine";recorded:TokenCounts|null;quotaCycle:{startsAt:string;resetsAt:string;recordedTokens:number|null;inputTokens?:number|null;cachedInputTokens?:number|null;boundaryIncomplete:boolean}|null;
  observedSessions:number;totalSessions:number;firstObservedAt:string|null;lastObservedAt:string|null;coverage:"observed-only";discontinuities:number;
  last:TokenCounts|null;nativeTotal:TokenCounts|null;modelContextWindow:number|null;
  accounts:{subscriptionType?:string|null;sourceMachine:string;identityKnown:boolean;observedAt:string;stale:boolean;credits?:UsageCredits|null;resetCardsAvailable?:number|null;windows:{bucket:string;window:string;usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number|null}[]}[];
  topWeeklyProjects:WeeklyUsageEntry[]|null;
  topWeeklySessions:WeeklyUsageEntry[]|null;
  topProjects:{id:string;title:string;totalTokens:number}[];
  topSessions:{id:string;title:string;totalTokens:number}[];
  projects?:UsageBreakdownEntry[];
  sessions?:UsageBreakdownEntry[];
  resetRadar?:{state:"unconfigured"|"pending"|"ready"|"error";checkedAt:string|null;nextCheckAt:string|null;timeline:{id:string;publishedAt:string;summary:string;signal:string;sourceUrl:string}[]};
  resetPrediction?:ResetPrediction|null;
}
