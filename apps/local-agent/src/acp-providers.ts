import {isSea} from 'node:sea';
import {access,readdir,readFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {delimiter,join,isAbsolute,resolve,relative} from 'node:path';
import {homedir} from 'node:os';
import type {AcpProviderId} from './provider-catalog.js';
import {AgentError} from './errors.js';
const exec=promisify(execFile);
/** `aliases` are legacy binary names; `identify` guards generic names such as Cursor's `agent`; `dirs` are default install locations outside PATH. */
export const ACP_COMMANDS:Record<AcpProviderId,{command:string;args:string[];npm:string[];aliases?:string[];identify?:RegExp;dirs?:string[][]}>={
  qwen:{command:'qwen',args:['--acp'],npm:['@qwen-code/qwen-code']},
  kimi:{command:'kimi',args:['acp'],npm:['@moonshot-ai/kimi-code']},
  cursor:{command:'agent',args:['acp'],npm:[],aliases:['cursor-agent'],identify:/cursor/i},
  codebuddy:{command:'codebuddy',args:['--acp'],npm:['@tencent-ai/codebuddy-code']},
  grok:{command:'grok',args:['--no-auto-update','agent','stdio'],npm:['@xai-official/grok'],dirs:[['.grok','bin']]},
};
/** Install locations of common version managers; the service PATH is usually minimal. */
const COMMON_HOME_DIRS=[['.local','bin'],['.npm-global','bin'],['.bun','bin'],['.volta','bin'],['.cargo','bin'],['.yarn','bin'],['.local','share','pnpm'],['.codebuddy','bin']];
async function nvmDirs():Promise<string[]> {
  const root=join(homedir(),'.nvm','versions','node');
  try {return (await readdir(root)).map(v=>join(root,v,'bin'));}catch{return [];}
}
const commandNames=(config:{command:string;aliases?:string[]|undefined})=>[config.command,...(config.aliases??[])];
export interface AcpExecutable { executable:string;prefix:string[];version:string; }
export async function detectAcp(provider:AcpProviderId):Promise<AcpExecutable|null> {
  const config=ACP_COMMANDS[provider];
  const dirs=[...new Set([...(process.env.PATH??'').split(delimiter).filter(isAbsolute),...COMMON_HOME_DIRS.map(d=>join(homedir(),...d)),...(config.dirs??[]).map(d=>join(homedir(),...d)),...(process.platform==='win32'?[join(homedir(),'AppData','Roaming','npm'),join(homedir(),'.grok','bin')]:['/usr/local/bin','/opt/homebrew/bin',...await nvmDirs()])])];
  let nodeExecutable:string|undefined=isSea()?undefined:process.execPath;
  if(process.platform==='win32'&&!nodeExecutable)for(const dir of dirs){
    try {const candidate=join(dir,'node.exe');const result=await exec(candidate,['--version'],{timeout:5000,maxBuffer:1024,windowsHide:true});if(/^v\d+\.\d+\.\d+\s*$/.test(result.stdout)){nodeExecutable=candidate;break;}}catch{/* An npm CLI requires a real Node executable, not the AgentFleet SEA binary. */}
  }
  for(const dir of dirs) {
    const candidates:Array<{executable:string;prefix:string[]}>=[];
    for(const name of commandNames(config))for(const suffix of process.platform==='win32'?['.exe','']:[''])candidates.push({executable:join(dir,name+suffix),prefix:[]});
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
      // `agent` is also installed by Grok. A generic executable name is not
      // evidence of Cursor: verify the vendor before starting its ACP process.
      if(config.identify&&!config.identify.test(version)) {
        // Official Cursor builds report only YYYY.MM.DD-<commit>, without a
        // vendor name. Verify their read-only ACP help; neither PATH order nor
        // the ambiguous `agent` filename alone establishes provider identity.
        if(provider!=='cursor'||!/^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7,40}$/i.test(version))continue;
        const help=await exec(candidate.executable,[...candidate.prefix,'acp','--help'],{timeout:5000,maxBuffer:32768,windowsHide:true});
        if(!/^Start the Cursor Agent as an ACP \(Agent Client Protocol\) server\s*$/m.test(help.stdout))continue;
      }
      return {...candidate,version};
    }catch{/* Not installed or not runnable. */}
  }
  return null;
}
/** A live owned Cursor ACP process may spawn its own Node worker. Those are not external writers. */
export function ownedProcessTree(rows:Array<{pid:number;ppid:number}>,owned:ReadonlySet<number>) {
  const tree=new Set(owned);let changed=true;
  while(changed){changed=false;for(const row of rows)if(row.ppid>0&&tree.has(row.ppid)&&!tree.has(row.pid)){tree.add(row.pid);changed=true;}}
  return tree;
}
export function isCursorNativeCommand(args:string) {
  const tokens=args.match(/"[^"]*"|'[^']*'|\S+/g)??[];
  return tokens.slice(0,2).some(token=>/(?:^|\/)cursor-agent(?:\/versions\/[^/]+\/(?:node|index\.js|cursor-agent(?:-sea)?)|(?:-sea)?)$/i.test(token.replace(/^['"]|['"]$/g,'').replaceAll('\\','/')));
}
/** Conservative across the host when native per-session ownership cannot be established. */
export async function assertAcpUnoccupied(provider:AcpProviderId,owned:Set<number>):Promise<void> {
  const config=ACP_COMMANDS[provider];
  const ownedAtScan=new Set(owned);
  let rows:Array<{pid:number;ppid:number;exe:string;args:string}>;
  try {
    if(process.platform==='win32') {
      const script='Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
      const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:8*1024*1024,windowsHide:true});
      const data=JSON.parse(result.stdout);rows=(Array.isArray(data)?data:[data]).map(r=>({pid:Number(r.ProcessId),ppid:Number(r.ParentProcessId),exe:String(r.ExecutablePath??''),args:String(r.CommandLine??'')}));
    } else {
      const result=await exec('ps',['-axo','pid=,ppid=,comm=,args='],{timeout:10000,maxBuffer:8*1024*1024});
      rows=result.stdout.split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),ppid:Number(m[2]),exe:m[3]!,args:m[4]!}]:[];});
    }
  }catch{throw new AgentError('PROVIDER_OWNERSHIP_UNKNOWN','Unable to verify native process ownership; write access remains disabled');}
  const ownedTree=provider==='cursor'?ownedProcessTree(rows,new Set([...ownedAtScan,...owned])):owned;
  for(const row of rows) {
    if(ownedTree.has(row.pid)||row.pid===process.pid)continue;
    const base=row.exe.replaceAll('\\','/').split('/').pop()?.toLowerCase();
    const args=row.args.replaceAll('\\','/'),tokens=args.split(/\s+/).slice(0,3).map(t=>t.split('/').pop()?.toLowerCase().replace(/\.exe$/,''));
    const names=commandNames(config).map(n=>n.toLowerCase());
    const generic=Boolean(config.identify);
    const named=names.some(n=>base===n||base===`${n}.exe`||tokens[0]===n||(['node','node.exe','python','python3','bun','deno'].includes(base??'')&&tokens.slice(0,3).includes(n)));
    // Generic names only count when the command line also shows the vendor.
    const cursorBinary=provider==='cursor'&&isCursorNativeCommand(args);
    const native=cursorBinary||(named&&(!generic||config.identify!.test(args)))||((base==='node'||base==='node.exe')&&config.npm.some(pkg=>args.includes(pkg+'/')));
    if(native&&provider==='cursor')try{process.kill(row.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')continue;}
    if(native)throw new AgentError('PROVIDER_NATIVE_BUSY','A native CLI may still own this session. Close that CLI before continuing in the panel.');
  }
}
