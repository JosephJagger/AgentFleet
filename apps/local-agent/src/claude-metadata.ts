import { createHash } from "node:crypto";
import type { AccountInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeModel { model: string; displayName: string; efforts: string[]; supportsAutoMode?:boolean; }
export interface ClaudeQuota { refreshFailed?: boolean; observedAt: string; available: boolean; subscriptionType: string | null; windows: Array<{bucket:string;window:string;usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number|null}>; }
export function normalizeClaudeMetadata(models: unknown, usage: unknown) {
  const catalog: ClaudeModel[] = [];
  if (Array.isArray(models)) for (const raw of models.slice(0,64)) {
    if (!raw || typeof raw !== "object") continue;
    const value=raw as Record<string,unknown>;
    const model=value.resolvedModel ?? value.value;
    if (typeof model !== "string" || !/^claude-[a-zA-Z0-9.-]{1,120}$/.test(model) || typeof value.displayName !== "string" || value.value === "default" || catalog.some(m=>m.model===model)) continue;
    catalog.push({model,...(typeof value.supportsAutoMode === "boolean" ? {supportsAutoMode:value.supportsAutoMode} : {}),displayName:value.displayName.slice(0,120),efforts:Array.isArray(value.supportedEffortLevels)?value.supportedEffortLevels.filter((e):e is string=>typeof e === "string" && ["low","medium","high","xhigh","max"].includes(e)):[]});
  }
  const value=usage && typeof usage === "object" ? usage as Record<string,unknown> : {};
  const quota:ClaudeQuota={observedAt:new Date().toISOString(),available:value.rate_limits_available===true,subscriptionType:typeof value.subscription_type === "string" ? value.subscription_type.slice(0,40) : null,windows:[]};
  const limits=value.rate_limits && typeof value.rate_limits === "object" ? value.rate_limits as Record<string,unknown> : {};
  const add=(raw:unknown,bucket:string,window:string,minutes:number)=>{
    if (!raw || typeof raw !== "object") return;
    const w=raw as Record<string,unknown>;
    if(typeof w.utilization !== "number" || !Number.isFinite(w.utilization) || w.utilization<0 || w.utilization>100)return;
    const reset=typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    quota.windows.push({bucket,window,usedPercent:w.utilization,remainingPercent:100-w.utilization,windowMinutes:minutes,resetsAt:Number.isFinite(reset)?Math.floor(reset/1000):null});
  };
  if (quota.available) {
    add(limits.five_hour,"claude","five_hour",300);add(limits.seven_day,"claude","seven_day",10080);
    add(limits.seven_day_opus,"Claude Opus","seven_day_opus",10080);add(limits.seven_day_sonnet,"Claude Sonnet","seven_day_sonnet",10080);
    add(limits.seven_day_oauth_apps,"OAuth apps","seven_day_oauth_apps",10080);
    if(Array.isArray(limits.model_scoped))for(const m of limits.model_scoped.slice(0,16))if(m && typeof m.display_name === "string")add(m,m.display_name.slice(0,80),`model:${m.display_name.slice(0,80)}`,10080);
  }
  return {models:catalog,quota};
}

/** Only kept in this process; neither account details nor this key enter discovery. */
export function claudeQuotaAccountKey(account: AccountInfo): string | undefined {
  if (!account.email || !account.organization || (account.apiProvider && account.apiProvider !== "firstParty") || (account.apiKeySource && account.apiKeySource !== "none")) return undefined;
  return createHash("sha256").update(JSON.stringify([
    account.email, account.organization, account.tokenSource, account.subscriptionType,
  ])).digest("hex");
}

export interface ClaudeMetadata {
  models: ClaudeModel[];
  quota: ClaudeQuota;
  quotaAccountKey?: string | undefined;
  quotaRefreshFailed?: boolean;
}

export function retainedClaudeQuota(previous: ClaudeQuota | undefined, previousKey: string | undefined, next: ClaudeMetadata): ClaudeQuota {
  // A successful unavailable result (logout, API key, missing scope) clears quota.
  // A failed request may reuse a snapshot only with fresh proof of the same account.
  if (next.quotaRefreshFailed && next.quotaAccountKey && next.quotaAccountKey === previousKey && previous?.available && previous.windows.length) {
    return {...previous, refreshFailed: true};
  }
  return next.quota;
}

async function metadataDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude metadata timeout")), 15_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Testable native control requests; no user prompt or inference is sent. */
export async function collectClaudeMetadata(q: Pick<Query, "supportedModels" | "accountInfo" | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">): Promise<ClaudeMetadata> {
  // Settle separately: a usage timeout must not discard a verified identity or models.
  const [models, usage, account] = await Promise.allSettled([
    metadataDeadline(() => q.supportedModels()),
    metadataDeadline(() => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})),
    metadataDeadline(() => q.accountInfo()),
  ]);
  const metadata = normalizeClaudeMetadata(models.status === "fulfilled" ? models.value : [], usage.status === "fulfilled" ? usage.value : null);
  return {
    ...metadata,
    quotaAccountKey: account.status === "fulfilled" ? claudeQuotaAccountKey(account.value) : undefined,
    quotaRefreshFailed: usage.status === "rejected" || (usage.value?.rate_limits_available !== false && !metadata.quota.windows.length),
  };
}

/** Native metadata only: the input stream never yields a user message or starts inference. */
export async function inspectClaudeMetadata(binary:string,owned:Set<number>,managed=false): Promise<ClaudeMetadata> {
  let release:(()=>void)|undefined;
  const prompt=async function*(){await new Promise<void>(resolve=>{release=resolve;});};
  const q=query({prompt:prompt(),options:{...(managed?{env:{...process.env,DISABLE_AUTOUPDATER:"1"}}:{}),cwd:homedir(),pathToClaudeCodeExecutable:binary,settingSources:["user","project","local"],spawnClaudeCodeProcess:options=>{
    const child=spawn(options.command,options.args,{cwd:options.cwd,env:options.env,stdio:["pipe","pipe","pipe"],windowsHide:true});
    if(child.pid){owned.add(child.pid);child.once("close",()=>owned.delete(child.pid!));}return child;
  }}});
  try {
    return await collectClaudeMetadata(q);
  } finally {release?.();q.close();}
}
