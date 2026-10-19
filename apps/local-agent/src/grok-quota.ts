const object=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
export interface GrokQuota {sharedSubscription?:{source:'grok-native';verifiedAt:string;expiresAt:string};observedAt:string;windows:Array<{bucket:'grok';window:'primary';usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number}>;}
/** Only native billing percentage and its actual period; no credentials, balances or history. */
export function grokBillingQuota(value:unknown,observedAt=new Date().toISOString()):GrokQuota|undefined {
  const config=object(object(value)?.config),period=object(config?.currentPeriod);
  const used=config?.creditUsagePercent,start=Date.parse(String(period?.start??'')),end=Date.parse(String(period?.end??''));
  const minutes=(end-start)/60000;
  if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100||!Number.isSafeInteger(minutes)||minutes<=0||minutes>366*1440||!Number.isFinite(start)||start>Date.parse(observedAt)||end<=Date.parse(observedAt))return;
  return {observedAt,windows:[{bucket:'grok',window:'primary',usedPercent:used,remainingPercent:100-used,windowMinutes:minutes,resetsAt:Math.floor(end/1000)}]};
}
/** Revalidate untrusted host metadata at the control-plane boundary. */
export function parseGrokQuota(value:unknown):GrokQuota|undefined {
  const v=object(value);if(!v||typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt))||Date.parse(v.observedAt)>Date.now()+60000||!Array.isArray(v.windows)||v.windows.length!==1)return;
  const w=object(v.windows[0]);if(!w||w.bucket!=='grok'||w.window!=='primary'||!Number.isSafeInteger(w.resetsAt)||Number(w.resetsAt)<=0||Number(w.resetsAt)>=1e11||!Number.isSafeInteger(w.windowMinutes))return;
  const end=Number(w.resetsAt)*1000,start=end-Number(w.windowMinutes)*60000;
  if(!Number.isFinite(start)||!Number.isFinite(end)||Math.abs(start)>8.64e15||end>8.64e15)return;
  const quota=grokBillingQuota({config:{creditUsagePercent:w.usedPercent,currentPeriod:{start:new Date(start).toISOString(),end:new Date(end).toISOString()}}},v.observedAt);
  const shared=object(v.sharedSubscription),verified=Date.parse(String(shared?.verifiedAt??'')),expires=Date.parse(String(shared?.expiresAt??''));
  if(quota&&shared?.source==='grok-native'&&Number.isFinite(verified)&&verified<=Date.now()+60000&&expires> Date.now()&&expires-verified<=180000&&expires>verified&&Math.abs(verified-Date.parse(v.observedAt))<=30000)quota.sharedSubscription={source:'grok-native',verifiedAt:String(shared.verifiedAt),expiresAt:String(shared.expiresAt)};
  return quota;
}
