import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentError } from "./errors.js";
const exec = promisify(execFile);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export interface VersionEntry { kind: "agent" | "codex" | "backup"; name: string; bytes: number; reason: "current" | "rollback" | "referenced" | "recent" | "unsafe" | "unused"; }
export interface VersionReport { checkedAt: string; totalBytes: number; reclaimableBytes: number; deletedBytes: number; deletedCount: number; retainedCount: number; entries: VersionEntry[]; entryCount: number; blocked: boolean; warning?: string; automatic?: boolean; }
interface Options { dataDir: string; referenceText?: string; home?: string; platform?: NodeJS.Platform; now?: number; processReferences?: () => Promise<string>; }
async function text(path: string): Promise<string> { try { if ((await lstat(path)).isSymbolicLink()) throw new Error("symbolic metadata"); return await readFile(path, "utf8"); } catch(e) { if(missing(e)) return ""; throw e; } }
async function exists(path: string) { try { await lstat(path); return true; } catch(e) { if(missing(e))return false;throw e; } }
const normal = (s: string) => s.replace(/\\+/g,"/");
async function references(): Promise<string> {
  if(process.platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath; $_.CommandLine }; Get-CimInstance Win32_Service | Where-Object {$_.PathName -like '*AgentFleet*'} | ForEach-Object {$_.PathName}; Get-ScheduledTask -TaskName '*AgentFleet*' | ForEach-Object { $_.Actions | ConvertTo-Json -Compress }; Get-Process | Where-Object {$_.Path -like '*AgentFleet*'} | ForEach-Object { $_.Modules | ForEach-Object {$_.FileName} }";
    return (await exec("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{windowsHide:true,timeout:25_000,maxBuffer:16*1024*1024})).stdout;
  }
  if(process.platform === "darwin") {
    const ps = await exec("/bin/ps",["-axo","command="],{timeout:10_000,maxBuffer:8*1024*1024});
    const files = await exec("/usr/sbin/lsof",["-nP","-u",String(process.getuid!()),"-F","n"],{timeout:20_000,maxBuffer:16*1024*1024});
    return ps.stdout+"\n"+files.stdout;
  }
  const all: string[]=[];
  for(const pid of await readdir("/proc")) {
    if(!/^\d+$/.test(pid))continue;
    const p=join("/proc",pid);let command="";
    try { command=await readFile(join(p,"cmdline"),"utf8");all.push(command); } catch(e) { if(!missing(e)&&(e as NodeJS.ErrnoException).code!=="EACCES")throw e; }
    for(const n of ["exe","cwd"])try{all.push(await readlink(join(p,n)));}catch(e){if(!missing(e)&&command.includes("agentfleet"))throw e;}
    try{all.push(await readFile(join(p,"maps"),"utf8"));}catch(e){if(!missing(e)&&/agentfleet|\/codex(?:\x00| )/i.test(command))throw e;}
    try { for(const fd of await readdir(join(p,"fd")))try{all.push(await readlink(join(p,"fd",fd)));}catch(e){if(!missing(e))throw e;} } catch(e){if(!missing(e)&&command.includes("agentfleet"))throw e;}
  }
  // Container mounts can retain old binaries even while their processes are stopped.
  try { const ids=(await exec("docker",["ps","-aq"],{timeout:5_000})).stdout.trim().split(/\s+/).filter(Boolean);if(ids.length)all.push((await exec("docker",["inspect",...ids],{timeout:10_000,maxBuffer:16*1024*1024})).stdout); }
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT" && process.getuid?.()===0)throw e;}
  return all.join("\n");
}
/** Shared with upgrade preparation; a crash leaves a PID-checked lock, never a timed deletion lease. */
export async function withVersionLock<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const path=join(dataDir,"version-cleanup.lock");await mkdir(dataDir,{recursive:true});
  let file;
  try { file=await open(path,"wx",0o600); }
  catch(e) {
    if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    // Serialize stale-lock recovery too: two recoverers must never unlink a new owner's lock.
    let recovery;
    try { recovery=await open(path+".recovery","wx",0o600); }
    catch { throw new AgentError("VERSION_CLEANUP_BUSY","版本检查或升级正在进行，请稍后重试"); }
    try {
      let dead=false;
      try { const p=JSON.parse(await text(path)); if(Number.isSafeInteger(p.pid)&&p.pid>0) {
        try { process.kill(p.pid,0); } catch(err) { dead=(err as NodeJS.ErrnoException).code==="ESRCH"; }
      }} catch {}
      if(!dead)throw new AgentError("VERSION_CLEANUP_BUSY","版本检查或升级正在进行，请稍后重试");
      await rm(path);file=await open(path,"wx",0o600);
    } finally { await recovery.close();await rm(path+".recovery",{force:true}); }
  }
  try{await file.writeFile(JSON.stringify({pid:process.pid}));return await work();}finally{await file.close();await rm(path,{force:true});}
}
async function tree(path: string): Promise<{bytes:number;safe:boolean}> {
  const m=await lstat(path);if(m.isSymbolicLink())return {bytes:0,safe:false};
  if(m.isFile())return {bytes:m.size,safe:true};if(!m.isDirectory())return {bytes:0,safe:false};
  let bytes=0,safe=true;for(const n of await readdir(path)){const v=await tree(join(path,n));bytes+=v.bytes;safe&&=v.safe;}return {bytes,safe};
}
async function metadata(o:Options) {
  const home=o.home??homedir(),platform=o.platform??process.platform;
  const values=await Promise.all(["runtime-profile.json","update-state.json"].map(n=>text(join(o.dataDir,n))));
  const pointers=platform==="win32" ? await Promise.all(["current.txt","previous.txt"].map(n=>text(join(o.dataDir,"bin",n)))) : await Promise.all(["agentfleet","agentfleet.previous"].map(async n=>{try{return await realpath(join(home,".local/bin",n));}catch(e){if(missing(e))return "";throw e;}}));
  return {values,pointers,digest:hash(JSON.stringify([values,pointers]))};
}
async function scan(o:Options) {
  const platform=o.platform??process.platform,home=o.home??homedir(),now=o.now??Date.now();
  const meta=await metadata(o),profile=JSON.parse(meta.values[0]||"null"),tx=JSON.parse(meta.values[1]||"null");
  if(!profile?.codexExecutable)throw new AgentError("VERSION_PROFILE_MISSING","运行配置尚未就绪，暂不清理版本");
  if(tx&&!['succeeded','rolled_back','failed'].includes(tx.phase))throw new AgentError("VERSION_UPDATE_ACTIVE","安装或升级尚未完成，暂不清理版本");
  const processText=normal(await (o.processReferences??references)());
  const persisted=normal(o.referenceText??"");
  const roots: Array<{path:string;kind:VersionEntry['kind']}>=[{path:platform==="darwin"?join(home,".local/share/agentfleet/bin"):join(o.dataDir,"bin"),kind:"agent"},{path:join(o.dataDir,"codex/releases"),kind:"codex"},{path:join(o.dataDir,"updates"),kind:"backup"}];
  const current=normal(platform==="win32"?join(roots[0]!.path,meta.pointers[0]!.trim()):meta.pointers[0]!),previous=normal(platform==="win32"?join(roots[0]!.path,meta.pointers[1]!.trim()):meta.pointers[1]!);
  const rollbackTexts=[previous,normal(tx?.previousTarget??""),normal(tx?.backupDir??"")];
  if(tx?.backupDir && roots[2] && dirname(resolve(tx.backupDir))===resolve(roots[2].path))rollbackTexts.push(normal(await text(join(tx.backupDir,"runtime-profile.json"))));
  const found: Array<VersionEntry & {path:string;stamp:string;mtime:number}>=[];
  for(const root of roots) {
    if(!await exists(root.path))continue;
    if(await realpath(root.path)!==resolve(root.path))throw new AgentError("VERSION_PATH_UNSAFE","版本目录包含链接，已停止清理");
    if(root.kind==="agent"&&(!current.startsWith(normal(root.path)+"/")||!await exists(platform==="win32"?join(root.path,meta.pointers[0]!.trim()):meta.pointers[0]!)))throw new AgentError("VERSION_CURRENT_UNKNOWN","无法确认正在使用的安装版本，已停止清理");
    for(const name of await readdir(root.path)) {
      if(!(root.kind==="agent"?/^\d+\.\d+\.\d+$/:root.kind==="codex"?/^\d+\.\d+\.\d+-[\w-]+$/:/^release-[\w-]+$/).test(name))continue;
      const path=join(root.path,name),m=await lstat(path);if(!m.isDirectory()||m.isSymbolicLink())continue;
      const prefix=normal(path),contains=(s:string)=>s===prefix||s.includes(prefix+"/")||s.includes(prefix+'"');
      const size=await tree(path);let reason:VersionEntry['reason']="unused";
      if(contains(current)||contains(normal(profile.codexExecutable)))reason="current";
      else if(rollbackTexts.some(contains)||(platform==="win32"&&root.kind==="agent"&&name===tx?.previousTarget))reason="rollback";
      else if(contains(processText)||contains(persisted)||contains(normal(process.execPath)))reason="referenced";
      else if(now-m.mtimeMs<3_600_000)reason="recent";
      if(!size.safe)reason="unsafe";
      if(root.kind==="backup"&&(await readdir(path)).some(n=>!['codex','codex.exe','bwrap','runtime-profile.json'].includes(n)))reason="unsafe";
      found.push({kind:root.kind,name,bytes:size.bytes,reason,path,stamp:`${m.dev}:${m.ino}:${m.mtimeMs}`,mtime:m.mtimeMs});
    }
  }
  // If installation has no explicit runtime rollback pointer, retain the newest complete prior runtime.
  if(!found.some(e=>e.kind==="codex"&&e.reason==="rollback")) {
    for(const e of found.filter(e=>e.kind==="codex"&&e.reason==="unused").sort((a,b)=>b.mtime-a.mtime))if(await exists(join(e.path,platform==="win32"?"codex.exe":"codex"))){e.reason="rollback";break;}
  }
  return {found,meta};
}
export async function manageVersions(o:Options, clean=false):Promise<VersionReport> {
  return withVersionLock(o.dataDir,async()=>{
    const {found,meta}=await scan(o);let deletedBytes=0,deletedCount=0;const removed=new Set<string>();
    if(clean) {
      const live=normal(await(o.processReferences??references)());
      for(const entry of found.filter(e=>e.reason==="unused")) {
        if((await metadata(o)).digest!==meta.digest)throw new AgentError("VERSION_STATE_CHANGED","安装状态已变化，请重新检查版本");
        const path=entry.path,m=await lstat(path);
        if(m.isSymbolicLink()||await realpath(path)!==resolve(path)||`${m.dev}:${m.ino}:${m.mtimeMs}`!==entry.stamp||live.includes(normal(path)+"/"))throw new AgentError("VERSION_STATE_CHANGED","版本文件正在使用或已变化，请重新检查");
        // rm never follows interior links; a final tree check also rejects replacement links.
        if(!(await tree(path)).safe)throw new AgentError("VERSION_PATH_UNSAFE","版本目录发生变化，已停止清理");
        await rm(path,{recursive:true});removed.add(path);deletedBytes+=entry.bytes;deletedCount++;
      }
    }
    const remaining=found.filter(e=>!removed.has(e.path));
    const report:VersionReport={checkedAt:new Date().toISOString(),totalBytes:remaining.reduce((s,e)=>s+e.bytes,0),reclaimableBytes:remaining.filter(e=>e.reason==="unused").reduce((s,e)=>s+e.bytes,0),deletedBytes,deletedCount,retainedCount:remaining.filter(e=>e.reason!=="unused").length,entries:remaining.slice(0,100).map(({kind,name,bytes,reason})=>({kind,name,bytes,reason})),entryCount:remaining.length,blocked:false};
    return report;
  });
}
export async function automaticVersionCleanup(o:Options):Promise<void> {
  const meta=await metadata(o),file=join(o.dataDir,"version-cleanup.json");
  const now=o.now??Date.now();
  const last=JSON.parse(await text(file)||"null");if(last?.fingerprint===meta.digest && last.nextScanAt>now)return;
  const report=await manageVersions(o,true),temp=file+`.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify({fingerprint:meta.digest,nextScanAt:now+(report.entries.some(e=>e.reason==="recent")?3_600_000:86_400_000),...report,automatic:true}),{mode:0o600});await rename(temp,file);
}
