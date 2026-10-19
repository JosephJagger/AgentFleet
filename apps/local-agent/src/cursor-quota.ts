import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir,platform} from 'node:os';
import {join} from 'node:path';
import {isRecord} from './util.js';

export interface CursorQuota {observedAt:string;planName?:string;windows:Array<{bucket:'cursor';window:'primary';usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number}>;}
const SERVICE='https://api2.cursor.sh/aiserver.v1.DashboardService';
// Custom credentials or endpoints can select another principal than the native login file.
const OVERRIDES=['CURSOR_API_KEY','CURSOR_AUTH_TOKEN','CURSOR_API_ENDPOINT','CURSOR_API_BASE_URL','CURSOR_WEBSITE_URL'];
export function cursorAuthPath(home:string,env:NodeJS.ProcessEnv,os=platform()):string{
  if(os==='win32')return join(env.APPDATA||join(home,'AppData','Roaming'),'Cursor','auth.json');
  if(os==='darwin')return join(home,'.cursor','auth.json');
  return join(env.XDG_CONFIG_HOME||join(home,'.config'),'cursor','auth.json');
}
const millis=(v:unknown):number=>{const n=typeof v==='string'&&/^\d{1,16}$/.test(v)?Number(v):typeof v==='number'?v:NaN;return Number.isSafeInteger(n)&&n>0?n:NaN;};
/** Only the used percentage, its actual period and the plan name; no credentials, spend or history. */
export function cursorUsageQuota(usage:unknown,plan:unknown,observedAt=new Date().toISOString()):CursorQuota|undefined {
  const used=isRecord(usage)&&isRecord(usage.planUsage)?usage.planUsage.totalPercentUsed:undefined;
  const start=millis(isRecord(usage)?usage.billingCycleStart:undefined),end=millis(isRecord(usage)?usage.billingCycleEnd:undefined),now=Date.parse(observedAt);
  const minutes=(end-start)/60000;
  if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100||!Number.isSafeInteger(minutes)||minutes<=0||minutes>366*1440||start>now||end<=now)return;
  const info=isRecord(plan)&&isRecord(plan.planInfo)?plan.planInfo:undefined;
  // The plan's own reset time wins when it describes the same included-usage period.
  const planReset=millis(info?.includedUsageResetsAt),resets=Number.isFinite(planReset)&&Math.abs(planReset-end)<=60000?planReset:end;
  const name=typeof info?.planName==='string'?info.planName.trim().slice(0,40):'';
  return {observedAt,...(name?{planName:name}:{}),windows:[{bucket:'cursor',window:'primary',usedPercent:used,remainingPercent:100-used,windowMinutes:minutes,resetsAt:Math.floor(resets/1000)}]};
}
/** undefined: no verifiable native login (logged out, custom credentials). Throws on transient failures so callers keep the prior timestamped observation. */
export async function readCursorQuota(options:{read?:typeof readFile;fetch?:typeof fetch;env?:NodeJS.ProcessEnv;home?:string;onIdentity?:(key:string|undefined)=>void}={}):Promise<CursorQuota|undefined> {
  const env=options.env??process.env,read=options.read??readFile,request=options.fetch??fetch;
  if(OVERRIDES.some(key=>env[key])){options.onIdentity?.(undefined);return;}
  const path=cursorAuthPath(options.home??homedir(),env);
  const readAuth=async()=>{try{const value:unknown=JSON.parse(String(await read(path,'utf8')));return isRecord(value)&&!value.apiKey&&typeof value.accessToken==='string'&&value.accessToken?value.accessToken:undefined;}catch{return undefined;}};
  const token=await readAuth();
  // This credential-generation fingerprint is process-local, never reported as account identity.
  const key=token?createHash('sha256').update(token).digest('hex'):undefined;
  options.onIdentity?.(key);
  if(!token)return;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json','Connect-Protocol-Version':'1'};
  const signal=AbortSignal.timeout(5000);
  const call=(method:string)=>request(`${SERVICE}/${method}`,{method:'POST',headers,body:'{}',signal,redirect:'error'});
  try {
    // Plan metadata is optional. Its network/JSON failure cannot override usage authentication.
    const planResult=call('GetPlanInfo').then(async r=>r.ok?await r.json():undefined).catch(()=>undefined);
    const usage=await call('GetCurrentPeriodUsage');
    if(usage.status===401||usage.status===403){options.onIdentity?.(undefined);return;}
    if(!usage.ok)throw new Error(`Cursor usage HTTP ${usage.status}`);
    const usageBody:unknown=await usage.json(),planBody:unknown=await planResult;
    if(await readAuth()!==token){options.onIdentity?.(undefined);return;}
    const quota=cursorUsageQuota(usageBody,planBody);
    if(!quota)throw new Error('Cursor usage response not recognised');
    return quota;
  } finally {
    // Also revoke a retained observation if logout/account switch happens during a failed request.
    if(OVERRIDES.some(k=>env[k])||await readAuth()!==token){options.onIdentity?.(undefined);return;}
  }
}
