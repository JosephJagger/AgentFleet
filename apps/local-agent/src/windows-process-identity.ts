import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
const timeoutMs=8000;
type Query=(pid:number)=>Promise<string>;
const query:Query=async pid=>{
 const {stdout}=await execFileAsync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],{timeout:timeoutMs,windowsHide:true,maxBuffer:16384,encoding:'utf8'});
 return stdout;
};
/** Retry only a timed-out query, never substitute a PID or a fabricated start time. */
export async function windowsProcessStartToken(pid:number,run:Query=query,report:(data:{attempt:number;reason:string;timeoutMs:number})=>void=data=>console.warn('PROCESS_IDENTITY_QUERY',data)):Promise<string|undefined>{
 if(!Number.isSafeInteger(pid)||pid<=0)return undefined;
 for(let attempt=1;attempt<=2;attempt++){
  try {
   const value=(await run(pid)).trim();
   if(!/^\d+$/u.test(value)){report({attempt,reason:'invalid_output',timeoutMs});return undefined;}
   return `windows:${value}`;
  }catch(error){
   const failure=error as {killed?:boolean;signal?:string;code?:unknown}|null;
   const timedOut=failure?.killed===true&&failure.signal==='SIGTERM'&&failure.code==null;
   // Query exit (e.g. missing/inaccessible PID), spawn errors and buffer errors
   // are not timeout evidence and must not be retried as if they were.
   if(!timedOut)return undefined;
   report({attempt,reason:'timeout',timeoutMs});
  }
 }
 return undefined;
}
