import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {flatUsage,type TokenCounts} from './acp-updates.js';
import {isRecord} from './util.js';
import type {AcpExecutable} from './acp-providers.js';

function completeCounts(value:Record<string,unknown>) {
  return ['inputTokens','outputTokens','cachedReadTokens','reasoningTokens','totalTokens'].every(key=>Number.isSafeInteger(value[key])&&Number(value[key])>=0)
    && Number(value.inputTokens)+Number(value.outputTokens)===value.totalTokens;
}
/** Persisted session totals survive native process release. In-memory ACP totals do not. */
export function grokPersistedUsage(value:unknown,sessionId:string,startedAt:number) {
  if(!isRecord(value)||value.sessionId!==sessionId||!isRecord(value.session)||!Array.isArray(value.turns))return;
  const lastRow=value.turns.at(-1);
  if(!isRecord(lastRow)||typeof lastRow.endedAt!=='string'||!Number.isFinite(Date.parse(lastRow.endedAt))||Date.parse(lastRow.endedAt)<startedAt||Date.parse(lastRow.endedAt)>Date.now()+60000)return;
  if(value.session.usageIsIncomplete===true||lastRow.usageIsIncomplete===true)return;
  if(!completeCounts(value.session)||!completeCounts(lastRow))return;
  const total=flatUsage(value.session),last=flatUsage(lastRow);
  if(!total||!last||last.totalTokens===0||Object.keys(total).some(k=>last[k as keyof TokenCounts]>total[k as keyof TokenCounts]))return;
  return {usage:{total,last}};
}
export async function readGrokUsage(executable:AcpExecutable,sessionId:string,startedAt:number) {
  try {
    const {stdout}=await promisify(execFile)(executable.executable,[...executable.prefix,'--no-auto-update','usage',sessionId],{timeout:3000,maxBuffer:4*1024*1024,windowsHide:true,encoding:'utf8'});
    return grokPersistedUsage(JSON.parse(stdout),sessionId,startedAt);
  }catch{return undefined;} // Unsupported/partial usage never becomes zero and never fails the task.
}
