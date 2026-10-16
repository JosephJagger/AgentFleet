import {isSea} from 'node:sea';
import {access,readFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {delimiter,join,isAbsolute,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import type {AcpProviderId} from './provider-catalog.js';
import {AgentError} from './errors.js';
const exec=promisify(execFile);
export const ACP_COMMANDS:Record<AcpProviderId,{command:string;args:string[];npm:string[]}>={
  qwen:{command:'qwen',args:['--acp'],npm:['@qwen-code/qwen-code']},
  kimi:{command:'kimi',args:['acp'],npm:['@moonshot-ai/kimi-code']},
  cursor:{command:'agent',args:['acp'],npm:[]},
  codebuddy:{command:'codebuddy',args:['--acp'],npm:['@tencent-ai/codebuddy-code']},
  grok:{command:'grok',args:['--no-auto-update','agent','stdio'],npm:[]},
};
export interface AcpExecutable { executable:string;prefix:string[];version:string; }
export async function detectAcp(provider:AcpProviderId):Promise<AcpExecutable|null> {
  const config=ACP_COMMANDS[provider];
  const dirs=[...new Set([...(process.env.PATH??'').split(delimiter).filter(isAbsolute),join(homedir(),'.local','bin'),join(homedir(),'.npm-global','bin'),...(process.platform==='win32'?[join(homedir(),'AppData','Roaming','npm')]:['/usr/local/bin','/opt/homebrew/bin'])])];
  let nodeExecutable:string|undefined=isSea()?undefined:process.execPath;
  if(process.platform==='win32'&&!nodeExecutable)for(const dir of dirs){
    try {const candidate=join(dir,'node.exe');const result=await exec(candidate,['--version'],{timeout:5000,maxBuffer:1024,windowsHide:true});if(/^v\d+\.\d+\.\d+\s*$/.test(result.stdout)){nodeExecutable=candidate;break;}}catch{/* An npm CLI requires a real Node executable, not the AgentFleet SEA binary. */}
  }
  for(const dir of dirs) {
    const candidates:Array<{executable:string;prefix:string[]}>=[];
    for(const suffix of process.platform==='win32'?['.exe','']:[''])candidates.push({executable:join(dir,config.command+suffix),prefix:[]});
    if(process.platform==='win32'&&nodeExecutable)for(const pkg of config.npm) {
      try {
        const root=join(dir,'node_modules',pkg);const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
        const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.[config.command];
        if(manifest.name!==pkg||typeof bin!=='string'||isAbsolute(bin))continue;
        const file=await realpath(resolve(root,bin));const rel=relative(await realpath(root),file);if(rel.startsWith('..')||isAbsolute(rel))continue;
        candidates.push({executable:nodeExecutable,prefix:[file]});
      }catch{/* Only explicit official package bins, never execute shell shims. */}
    }
    for(const candidate of candidates)try {
      await access(candidate.executable);
      const result=await exec(candidate.executable,[...candidate.prefix,'--version'],{timeout:5000,maxBuffer:8192,windowsHide:true});
      const version=result.stdout.trim();if(!/\d+\.\d+\.\d+/.test(version)||version.length>200)continue;
      return {...candidate,version};
    }catch{/* Not installed or not runnable. */}
  }
  return null;
}
/** Conservative across the host when native per-session ownership cannot be established. */
export async function assertAcpUnoccupied(provider:AcpProviderId,owned:Set<number>):Promise<void> {
  const config=ACP_COMMANDS[provider];
  let rows:Array<{pid:number;exe:string;args:string}>;
  try {
    if(process.platform==='win32') {
      const script='Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
      const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:8*1024*1024,windowsHide:true});
      const data=JSON.parse(result.stdout);rows=(Array.isArray(data)?data:[data]).map(r=>({pid:Number(r.ProcessId),exe:String(r.ExecutablePath??''),args:String(r.CommandLine??'')}));
    } else {
      const result=await exec('ps',['-axo','pid=,comm=,args='],{timeout:10000,maxBuffer:8*1024*1024});
      rows=result.stdout.split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),exe:m[2]!,args:m[3]!}]:[];});
    }
  }catch{throw new AgentError('PROVIDER_OWNERSHIP_UNKNOWN','Unable to verify native process ownership; write access remains disabled');}
  for(const row of rows) {
    if(owned.has(row.pid)||row.pid===process.pid)continue;
    const base=row.exe.replaceAll('\\','/').split('/').pop()?.toLowerCase();
    const native=base===config.command||base===`${config.command}.exe`||((base==='node'||base==='node.exe')&&config.npm.some(pkg=>row.args.replaceAll('\\','/').includes(pkg+'/')));
    if(native)throw new AgentError('PROVIDER_NATIVE_BUSY','A native CLI may still own this session. Close that CLI before continuing in the panel.');
  }
}
