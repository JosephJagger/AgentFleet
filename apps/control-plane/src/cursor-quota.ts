const object=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
export interface CursorQuota {observedAt:string;planName?:string;windows:Array<{bucket:'cursor';window:'primary';usedPercent:number;remainingPercent:number;windowMinutes:number;resetsAt:number}>;}
/** Revalidate untrusted host metadata at the control-plane boundary: percentage, actual period and plan name only. */
export function parseCursorQuota(value:unknown):CursorQuota|undefined {
  const v=object(value);if(!v||typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt))||Date.parse(v.observedAt)>Date.now()+60000||!Array.isArray(v.windows)||v.windows.length!==1)return;
  const w=object(v.windows[0]);if(!w||w.bucket!=='cursor'||w.window!=='primary'||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0||w.usedPercent>100)return;
  if(!Number.isSafeInteger(w.resetsAt)||Number(w.resetsAt)<=0||Number(w.resetsAt)>=1e11||!Number.isSafeInteger(w.windowMinutes)||Number(w.windowMinutes)<=0||Number(w.windowMinutes)>366*1440)return;
  const name=typeof v.planName==='string'?v.planName.trim().slice(0,40):'';
  return {observedAt:v.observedAt,...(name?{planName:name}:{}),windows:[{bucket:'cursor',window:'primary',usedPercent:w.usedPercent,remainingPercent:100-w.usedPercent,windowMinutes:Number(w.windowMinutes),resetsAt:Number(w.resetsAt)}]};
}
