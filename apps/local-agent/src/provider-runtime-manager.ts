import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { detectClaude, detectClaudePermissionModes } from './claude-runtime.js';
import { detectAcp } from './acp-providers.js';
import { ACP_PROVIDER_IDS } from './provider-catalog.js';
import { AgentError } from './errors.js';
import { verifyDetachedSignature } from './openpgp-verify.js';
import type { StateStore } from './store.js';
import { parseProviderRuntimeRequest, type ManagedProviderRelease, type ProviderRuntimeState } from './provider-runtime-policy.js';
const exec = promisify(execFile);
export const CLAUDE_SDK_VERSION = '0.3.285';
export const CLAUDE_RELEASE_BASE = 'https://downloads.claude.ai/claude-code-releases';
const MAX_BINARY = 512 * 1024 * 1024;
/** Official npm packages used only to *discover* the newest release; nothing is downloaded from them. */
export const NPM_PACKAGES:Readonly<Record<string,string>>={qwen:'@qwen-code/qwen-code',kimi:'@moonshot-ai/kimi-code',codebuddy:'@tencent-ai/codebuddy-code',grok:'@xai-official/grok'};
const LATEST_INTERVAL_MS=6*60*60_000;
async function npmLatest(pkg:string,signal?:AbortSignal):Promise<string> {
  const r=await fetch(`https://registry.npmjs.org/-/package/${pkg.replace('/','%2F')}/dist-tags`,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])])});
  if(!r.ok)throw new AgentError('PROVIDER_RELEASE_UNAVAILABLE','无法读取官方版本',{status:r.status});
  const text=await r.text();if(text.length>65_536)throw new Error('Release response too large');
  const latest=(JSON.parse(text) as {latest?:unknown}).latest;
  if(!stableVersion(latest))throw new Error('Invalid latest version');
  return latest;
}
const MAX_ATTEMPTS_PER_VERSION=3,TRANSIENT_RETRY_MS=30*60_000,BLOCKED_RETRY_MS=6*60*60_000;
/** Outcomes that are not a failure of the target release and must not mark the channel blocked. */
const PASSIVE_CODES=new Set(['PROVIDER_HOST_BUSY','PROVIDER_POLICY_CONFLICT','PROVIDER_HOST_NEWER','PROVIDER_RETRY_LIMIT']);
const isTransient=(e:unknown)=>e instanceof AgentError?e.code==='PROVIDER_RELEASE_UNAVAILABLE':e instanceof TypeError||(e instanceof Error&&(e.name==='TimeoutError'||e.name==='AbortError'));
const stableVersion = (s:unknown):s is string => typeof s === 'string' && /^\d+\.\d+\.\d+$/.test(s);
const versionOf = (s:string|null|undefined) => s?.match(/\d+\.\d+\.\d+/)?.[0];
export function newerVersion(a:string,b:string) {const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]!>y[i]!;}return false;}
export function claudePlatform(platform=process.platform,arch=process.arch):string {
  if (!['linux','darwin','win32'].includes(platform) || !['x64','arm64'].includes(arch)) throw new AgentError('PROVIDER_PLATFORM_UNSUPPORTED','此系统暂不支持 Claude 独立托管');
  const musl = platform === 'linux' && !(process.report.getReport() as {header?:{glibcVersionRuntime?:string}}).header?.glibcVersionRuntime;
  return `${platform}-${arch}${musl?'-musl':''}`;
}
export function reviewedManifest(raw:unknown,version:string,platform:string):ManagedProviderRelease {
  const m=raw as {version?:unknown;sdkCompat?:{harnessSchema?:unknown;testedWrapperVersions?:unknown};platforms?:Record<string,{checksum?:unknown;size?:unknown;binary?:unknown}>};
  const artifact=m?.platforms?.[platform];
  if (!stableVersion(version) || m?.version!==version || m.sdkCompat?.harnessSchema!==1 || !Array.isArray(m.sdkCompat.testedWrapperVersions) || !m.sdkCompat.testedWrapperVersions.includes(CLAUDE_SDK_VERSION)) throw new AgentError('PROVIDER_SDK_UNREVIEWED','官方清单尚未确认当前 Claude SDK 组合，保留现有版本');
  if (!artifact || !/^[a-f0-9]{64}$/.test(String(artifact.checksum)) || !Number.isSafeInteger(artifact.size) || Number(artifact.size)<=0 || Number(artifact.size)>MAX_BINARY || artifact.binary!==(platform.startsWith('win32')?'claude.exe':'claude')) throw new AgentError('PROVIDER_ARTIFACT_INVALID','官方版本文件信息不完整');
  return {version,sha256:String(artifact.checksum),size:Number(artifact.size),platform,checkedAt:new Date().toISOString(),sdkVersion:CLAUDE_SDK_VERSION};
}
/** `timeout` bounds only the connection and response headers; bodies are bounded by a stall guard so slow links still finish. */
async function response(path:string,timeout=20_000,signal?:AbortSignal) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new DOMException('Release request timed out','TimeoutError')),timeout);
  try {
    const r=await fetch(`${CLAUDE_RELEASE_BASE}/${path}`,{redirect:'error',signal:AbortSignal.any([controller.signal,...(signal?[signal]:[])])});
    if(!r.ok)throw new AgentError('PROVIDER_RELEASE_UNAVAILABLE','无法读取官方 Claude 版本',{status:r.status});
    return r;
  } finally {clearTimeout(timer);}
}
/** Aborts a transfer that stops delivering data for `ms`, without limiting how long a steadily progressing one may take. */
export function stallGuard(readable:Readable,ms:number):Readable {
  let timer:ReturnType<typeof setTimeout>|undefined;
  const arm=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>readable.destroy(new DOMException('Release download stalled','TimeoutError')),ms);};
  arm();readable.on('data',arm);readable.once('close',()=>{if(timer)clearTimeout(timer);});
  return readable;
}
async function limitedBytes(path:string,signal?:AbortSignal) {const r=await response(path,20_000,signal);if(!r.body)throw new Error('Empty release response');const chunks:Buffer[]=[];let size=0;for await(const b of stallGuard(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream),30_000)){const chunk=Buffer.from(b);size+=chunk.length;if(size>256_000)throw new Error('Release response too large');chunks.push(chunk);}return Buffer.concat(chunks);}
async function limitedText(path:string,signal?:AbortSignal) {return (await limitedBytes(path,signal)).toString('utf8');}
/** Releases from 2.1.89 publish a detached OpenPGP signature of manifest.json; the manifest vouches for every binary digest. */
async function signedManifest(version:string,signal?:AbortSignal):Promise<unknown> {
  const [manifest,signature]=await Promise.all([limitedBytes(`${version}/manifest.json`,signal),limitedBytes(`${version}/manifest.json.sig`,signal).catch(error=>{if(error instanceof AgentError&&error.details?.status===404)throw new AgentError('PROVIDER_SIGNATURE_MISSING','官方清单缺少签名，拒绝使用');throw error;})]);
  verifyDetachedSignature(manifest,signature.toString('utf8'));
  return JSON.parse(manifest.toString('utf8'));
}
async function digest(file:string) {const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function download(release:ManagedProviderRelease,file:string,signal?:AbortSignal,onProgress?:(received:number)=>void) {
  // 90 minutes is an upper bound for a very slow but live connection; a stalled one is cut off after a minute of silence.
  const bounded=AbortSignal.any([AbortSignal.timeout(90*60_000),...(signal?[signal]:[])]);
  const r=await response(`${release.version}/${release.platform}/${release.platform.startsWith('win32')?'claude.exe':'claude'}`,60_000,bounded);
  if(!r.body)throw new Error('Empty binary response');const temp=`${file}.${randomUUID()}.partial`;await mkdir(join(file,'..'),{recursive:true,mode:0o700});
  const handle=await open(temp,'wx',0o700);const hash=createHash('sha256');let size=0;
  try {for await(const chunk of stallGuard(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream),60_000)){size+=chunk.byteLength;if(size>release.size)throw new Error('Binary too large');hash.update(chunk);await handle.writeFile(chunk);onProgress?.(size);}if(size!==release.size||hash.digest('hex')!==release.sha256)throw new AgentError('PROVIDER_DIGEST_MISMATCH','Claude 文件校验失败');await handle.sync();await handle.close();await rename(temp,file);}
  catch(e){await handle.close().catch(()=>{});await rm(temp,{force:true});throw e;}
}
/** No prompt, no login, no task: validate the actual pinned SDK's control handshake. */
export async function probeClaude(binary:string,expectedVersion:string,signal?:AbortSignal):Promise<void> {
  const env={...process.env,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const v=await exec(binary,['--version'],{timeout:10_000,maxBuffer:8192,windowsHide:true,env,...(signal?{signal}:{})});
  if(versionOf(v.stdout)!==expectedVersion)throw new AgentError('PROVIDER_VERSION_MISMATCH','实际 Claude 版本与目标不一致');
  const cwd=await mkdtemp(join(tmpdir(),'agentfleet-claude-probe-'));let release:(()=>void)|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let q:ReturnType<typeof query>|undefined;
  try {
    q=query({prompt:(async function*(){await new Promise<void>(r=>{release=r;});})(),options:{cwd,pathToClaudeCodeExecutable:binary,env,settingSources:[],persistSession:false,tools:[],mcpServers:{},strictMcpConfig:true,permissionMode:'default'}});
    signal?.throwIfAborted();
    const abort=()=>q?.close();signal?.addEventListener("abort",abort,{once:true});
    try {await Promise.race([q.supportedModels().then(models=>{if(!Array.isArray(models))throw new Error('Invalid SDK handshake');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SDK handshake timed out')),15_000);})]);}finally{signal?.removeEventListener('abort',abort);}
    signal?.throwIfAborted();
  } finally {if(timer)clearTimeout(timer);release?.();q?.close();await rm(cwd,{recursive:true,force:true});}
}
const defaults={host:detectClaude,acp:detectAcp,stable:async(signal?:AbortSignal)=>{const version=(await limitedText('stable',signal)).trim();if(!stableVersion(version))throw new Error('Invalid stable version');return version;},manifest:async(version:string,platform:string,signal?:AbortSignal)=>reviewedManifest(await signedManifest(version,signal),version,platform),latest:async(id:string,signal?:AbortSignal):Promise<string|null>=>NPM_PACKAGES[id]?npmLatest(NPM_PACKAGES[id]!,signal):null,download,probe:probeClaude};
export class ProviderRuntimeManager {
  private busy=false;
  private readonly controller=new AbortController();
  private completion:Promise<void>|undefined;
  async stop(){this.controller.abort();await this.completion;}
  private verified=new Map<string,string>();
  /** Failures are classified so a network blip never freezes automatic updates, and a bad release is not re-downloaded forever. */
  private retryAfter=0;
  private failure?:{version:string;count:number};
  private prunedOnce=false;
  private latestAt=0;
  constructor(private readonly store:StateStore,private readonly activate:()=>Promise<void>,private readonly deps:typeof defaults & {permissionModes?:typeof detectClaudePermissionModes}=defaults,private readonly now:()=>number=Date.now){}
  state():ProviderRuntimeState {return this.store.snapshot().providerRuntimeState??{revision:0,mode:'host'};}
  private file(r:ManagedProviderRelease){if(!stableVersion(r.version)||! /^[a-f0-9]{64}$/.test(r.sha256)||r.platform!==claudePlatform())throw new Error('Invalid managed runtime identity');return join(this.store.dataDir,'provider-runtimes','claude',`${r.version}-${r.sha256}`,process.platform==='win32'?'claude.exe':'claude');}
  private async verify(r:ManagedProviderRelease) {const file=this.file(r),s=await stat(file);const key=`${s.size}:${s.mtimeMs}:${s.ctimeMs}`;if(s.size!==r.size)throw new Error('Managed runtime size mismatch');if(this.verified.get(file)!==key){if(await digest(file)!==r.sha256)throw new Error('Managed runtime checksum mismatch');this.verified.set(file,key);}return file;}
  async detectClaude():ReturnType<typeof detectClaude> {
    const state=this.state();if(state.mode==='host')return {...await this.deps.host(),managed:false};
    if(!state.current)throw new AgentError('PROVIDER_MANAGED_MISSING','Claude 托管版本缺失，请检查版本或切回宿主机');
    if(state.current.sdkVersion!==CLAUDE_SDK_VERSION)throw new AgentError('PROVIDER_SDK_CHANGED','Claude SDK 已变更，请重新核验托管版本');
    const path=await this.verify(state.current);
    const permissionModes=await (this.deps.permissionModes ?? detectClaudePermissionModes)(path);
    return {installed:true,version:state.current.version,path,managed:true,permissionModes};
  }
  /** A patch value of `undefined` removes the field. */
  private async save(patch:{[K in keyof ProviderRuntimeState]?:ProviderRuntimeState[K]|undefined}){
    await this.store.update(s=>{
      const next:Record<string,unknown>={...(s.providerRuntimeState??{revision:0,mode:'host'}),...patch};
      for(const [key,value] of Object.entries(patch))if(value===undefined)delete next[key];
      s.providerRuntimeState=next as unknown as ProviderRuntimeState;
    });
  }
  /** Progress is advisory: throttled, best effort, and never allowed to fail or slow the transfer. */
  private progressReporter(total:number){
    let last=0;
    return (received:number)=>{
      const now=this.now();if(received<total&&now-last<3000)return;last=now;
      void this.save({step:'downloading',progress:{received:Math.min(received,total),total}}).catch(()=>undefined);
    };
  }
  async inventory(runtimes:Record<string,unknown>,codex:Record<string,unknown>):Promise<Record<string,unknown>> {
    const host=await this.deps.host();const state=this.state();
    let managedValid=false;if(state.current&&state.current.sdkVersion===CLAUDE_SDK_VERSION){try{await this.verify(state.current);managedValid=true;}catch{/* Report damaged files as unverified; never silently fall back. */}}
    const providers:Record<string,unknown>={codex:{...codex,policy:'existing',managedSupported:true},claude:{installed:state.mode==='host'?host.installed:managedValid,hostVersion:host.version,version:state.mode==='host'?host.version:state.current?.version??null,source:state.mode==='host'?'host':'managed',policy:state.mode,sdkVersion:CLAUDE_SDK_VERSION,compatibility:state.mode!=='host'?(managedValid?'protocol_checked':'unverified'):state.hostCompatibility?.version===versionOf(host.version)?state.hostCompatibility?.state??'unverified':'unverified',managedSupported:true,...state}};
    for(const id of ACP_PROVIDER_IDS){const r=runtimes[id] as {version?:string;state?:string;checkedAt?:string}|undefined;let found:Awaited<ReturnType<typeof detectAcp>>=null;try{found=await this.deps.acp(id);}catch{/* A broken optional runtime must not hide successful activation or other providers. */}providers[id]={installed:Boolean(found),version:found?.version??null,source:'host',policy:'host',managedSupported:false,compatibility:found&&r?.version===found.version&&r.state==='ready'?'protocol_checked':'unverified',checkedAt:r?.checkedAt??null};}
    return {checkedAt:new Date().toISOString(),providers};
  }
  async operate(value:unknown,operationId:string,origin:'manual'|'automatic'='manual'):Promise<Record<string,unknown>> {
    this.controller.signal.throwIfAborted();
    const parsed=parseProviderRuntimeRequest(value);
    // Codex confirmations belong to the connection-service updater, never to the Claude runtime manager.
    if(parsed.action==='confirm')throw new AgentError('PROVIDER_REQUEST_UNSUPPORTED','此确认由连接服务更新器处理');
    let request:Exclude<typeof parsed,{action:'confirm'|'update'}>|{action:'update';provider:'claude';expectedRevision:number}=parsed;
    let userConfirmedUpdate=false;
    if(this.busy)throw new AgentError('PROVIDER_UPDATE_BUSY','版本检查或更新正在进行');this.busy=true;
    let done!:()=>void;this.completion=new Promise(resolve=>{done=resolve;});
    const signal=this.controller.signal;
    let admitted=false;
    try {
      let state=this.state();
      if(request.action!=='check'&&request.expectedRevision!==state.revision)throw new AgentError('PROVIDER_POLICY_CONFLICT','版本设置已变化，请重新读取');
      if(request.action==='update') {
        // Only an already managed build can be advanced; a host installation is updated by its own installer.
        if(state.mode==='host'||!state.current)throw new AgentError('PROVIDER_NOT_MANAGED','宿主机安装请用其自带的更新方式；如需由面板管理，请先选择托管版本');
        request={action:'configure',provider:'claude',mode:state.mode,expectedRevision:request.expectedRevision};userConfirmedUpdate=true;
      }
      if(request.action==='check') {
        try {const version=await this.deps.stable(signal);await this.save({stableVersion:version,checkedAt:new Date().toISOString()});await this.deps.manifest(version,claudePlatform(),signal);await this.save({error:'',phase:state.mode==='host'?'idle':'ready'});}

        catch(e){await this.save(isTransient(e)?{error:'官方版本服务暂时不可用，将自动重试'}:{phase:'blocked',error:e instanceof AgentError?e.message:'官方版本检查失败，保留当前版本'});}
        const host=await this.deps.host();const v=versionOf(host.version);
        if(host.path&&v) {
          let state:'protocol_checked'|'unverified'='unverified';
          try{await this.deps.manifest(v,claudePlatform(),signal);await this.deps.probe(host.path,v,signal);state='protocol_checked';}catch{/* Keep host-managed installations usable; this is evidence, not a new admission gate. */}
          await this.save({hostCompatibility:{version:v,checkedAt:new Date().toISOString(),state,sdkVersion:CLAUDE_SDK_VERSION}});
        }
        await this.refreshLatest(true).catch(()=>undefined);
        return {policy:this.state()};
      }
      if(request.action==='configure'&&request.mode==='host') {
        const host=await this.deps.host();if(!host.installed)throw new AgentError('PROVIDER_NOT_INSTALLED','宿主机没有可用的 Claude Code');
        admitted=await this.store.tryBeginUpdate(operationId);if(!admitted)throw new AgentError('PROVIDER_HOST_BUSY','任务或通话进行中，暂未切换版本，请空闲后重试');
        await this.commit({...state,revision:state.revision+1,mode:'host',phase:'idle'},state);return {policy:this.state()};
      }
      if(request.action==='rollback') {
        if(!state.previous)throw new AgentError('PROVIDER_NO_ROLLBACK','暂无之前成功使用的托管版本');
        await this.verify(state.previous);
        const previous=state.previous.sdkVersion===CLAUDE_SDK_VERSION?state.previous:await this.deps.manifest(state.previous.version,claudePlatform(),signal);
        if(previous.sha256!==state.previous.sha256)throw new AgentError('PROVIDER_TARGET_CHANGED','回退版本摘要已变化');
        await this.deps.probe(this.file(previous),previous.version,signal);
        admitted=await this.store.tryBeginUpdate(operationId);if(!admitted)throw new AgentError('PROVIDER_HOST_BUSY','任务或通话进行中，暂未回退');
        await this.commit({...state,revision:state.revision+1,mode:'pinned',current:previous,...(state.current?{previous:state.current}:{}),phase:'ready',error:'',failedVersion:''},state);
        return {policy:this.state()};
      }
      if(request.mode==='pinned' && state.mode!=='host' && state.current && !userConfirmedUpdate) {
        await this.verify(state.current);
        if(state.current.sdkVersion!==CLAUDE_SDK_VERSION){
          const reviewed=await this.deps.manifest(state.current.version,claudePlatform(),signal);
          if(reviewed.sha256!==state.current.sha256)throw new AgentError('PROVIDER_TARGET_CHANGED','官方文件摘要已变化');
          await this.deps.probe(this.file(state.current),state.current.version,signal);
          admitted=await this.store.tryBeginUpdate(operationId);if(!admitted)throw new AgentError('PROVIDER_HOST_BUSY','任务或通话进行中，暂未切换');
          await this.commit({...state,revision:state.revision+1,mode:'pinned',current:reviewed,phase:'ready',error:''},state);return {policy:this.state()};
        }
        await this.save({revision:state.revision+1,mode:'pinned',phase:'ready'});return {policy:this.state()};
      }
      const version=await this.deps.stable(signal);
      if(origin==='automatic'&&this.failure?.version===version&&this.failure.count>=MAX_ATTEMPTS_PER_VERSION)throw new AgentError('PROVIDER_RETRY_LIMIT','该版本多次验证失败，等待新的稳定版本或手动重试');
      if(!state.current) {
        // Enabling managed mode must not replace a newer host installation with an older stable build.
        const hostVersion=versionOf((await this.deps.host().catch(()=>null))?.version);
        if(hostVersion&&newerVersion(hostVersion,version))throw new AgentError('PROVIDER_HOST_NEWER',`宿主机 Claude ${hostVersion} 比官方稳定版 ${version} 更新，未切换以避免降级；继续使用宿主机版本`);
      }
      // Auto channel never silently downgrades a pinned version newer than stable.
      if(state.current && !newerVersion(version,state.current.version)) {
        await this.verify(state.current);
        if(state.mode===request.mode&&state.current.sdkVersion===CLAUDE_SDK_VERSION){await this.save({checkedAt:new Date().toISOString(),stableVersion:version,phase:'ready',error:''});return {policy:this.state()};}
        const reviewed=await this.deps.manifest(state.current.version,claudePlatform(),signal);
        if(reviewed.sha256!==state.current.sha256)throw new AgentError('PROVIDER_TARGET_CHANGED','同版本官方文件摘要已变化，请核验后重试');
        await this.deps.probe(this.file(state.current),state.current.version,signal);
        admitted=await this.store.tryBeginUpdate(operationId);if(!admitted)throw new AgentError('PROVIDER_HOST_BUSY','任务或通话进行中，暂未切换');
        await this.commit({...state,revision:state.revision+1,mode:request.mode,current:reviewed,phase:'ready',checkedAt:new Date().toISOString(),stableVersion:version,error:''},state);return {policy:this.state()};
      }
      await this.save({phase:'checking',stableVersion:version,checkedAt:new Date().toISOString()});
      const target=await this.deps.manifest(version,claudePlatform(),signal);
      const file=this.file(target);try{await this.verify(target);}catch{await this.save({step:'downloading',progress:{received:0,total:target.size}});await this.deps.download(target,file,signal,this.progressReporter(target.size));await this.save({step:'verifying',progress:undefined});await this.verify(target);}
      await this.save({step:'verifying',progress:undefined});
      await this.deps.probe(file,version,signal);
      if(await this.deps.stable(signal)!==version)throw new AgentError('PROVIDER_TARGET_CHANGED','官方稳定目标已变化，请重新检查');
      admitted=await this.store.tryBeginUpdate(operationId);
      if(!admitted){await this.save({phase:'waiting_idle'});throw new AgentError('PROVIDER_HOST_BUSY','目标已下载并验证，当前任务或通话结束后可再次应用');}
      state=this.state();
      await this.commit({...state,revision:state.revision+1,mode:request.mode,current:target,...(state.current?{previous:state.current}:{}),phase:'ready',error:'',failedVersion:''},state);
      return {policy:this.state()};
    } catch(e) {
      const code=e instanceof AgentError?e.code:'';
      if(code==='PROVIDER_RETRY_LIMIT')this.retryAfter=this.now()+BLOCKED_RETRY_MS;
      if(!signal.aborted && !PASSIVE_CODES.has(code)) {
        if(isTransient(e)) await this.save({error:'官方版本服务暂时不可用，将自动重试'});
        else await this.save({phase:'blocked',error:e instanceof AgentError?e.message:'版本验证或切换失败，保留之前版本',failedVersion:this.state().stableVersion??''});
        this.noteFailure(e);
      }
      throw e instanceof AgentError ? e : new AgentError('PROVIDER_UPDATE_FAILED','版本验证或切换失败，保留原版本；请检查主机连接和运行环境');
    } finally {try{if(admitted)await this.store.finishUpdateAdmission(operationId);}finally{try{if(!signal.aborted){if(this.state().step||this.state().progress)await this.save({step:undefined,progress:undefined});await this.prune();}}catch{/* Cleanup is best effort; never mask the operation result. */}this.busy=false;done();}}
  }
  private async commit(next:ProviderRuntimeState,previous:ProviderRuntimeState) {
    this.controller.signal.throwIfAborted();
    await this.store.update(s=>{s.providerRuntimeState=next;});
    try{await this.activate();}
    catch(e){await this.store.update(s=>{s.providerRuntimeState={...previous,revision:next.revision,mode:previous.mode==='auto'?'pinned':previous.mode,phase:'blocked',error:'启用失败，已回退；自动更新暂停'};});await this.activate().catch(()=>{});throw e;}
  }
  /** Read-only discovery of the newest official release of each agent. Failures keep the last known value. */
  async refreshLatest(force=false):Promise<void> {
    if(this.controller.signal.aborted||(!force&&this.latestAt&&this.now()-this.latestAt<LATEST_INTERVAL_MS))return;
    this.latestAt=this.now();
    const previous=this.state().latest??{};const next={...previous};const checkedAt=new Date(this.now()).toISOString();
    await Promise.all(['claude',...Object.keys(NPM_PACKAGES)].map(async id=>{
      try {const version=id==='claude'?await this.deps.stable(this.controller.signal):await this.deps.latest(id,this.controller.signal);if(stableVersion(version))next[id]={version,checkedAt};}
      catch {/* Discovery is advisory; an unreachable registry must never affect running agents. */}
    }));
    if(this.controller.signal.aborted)return;
    if(JSON.stringify(Object.entries(next).map(([k,v])=>[k,v.version]))!==JSON.stringify(Object.entries(previous).map(([k,v])=>[k,v.version]))||Object.keys(previous).length===0)await this.save({latest:next});
  }
  private noteFailure(e:unknown) {
    const transient=isTransient(e);
    this.retryAfter=this.now()+(transient?TRANSIENT_RETRY_MS:BLOCKED_RETRY_MS);
    if(transient)return;
    const version=this.state().stableVersion??'';
    this.failure=this.failure?.version===version?{version,count:this.failure.count+1}:{version,count:1};
  }
  /** Keep only the current and previous managed builds (plus a downloaded candidate awaiting an idle host). */
  private async prune() {
    const root=join(this.store.dataDir,'provider-runtimes','claude');
    let names:string[];try{names=await readdir(root);}catch{return;}
    const s=this.state();
    const keep=new Set([s.current,s.previous].flatMap(r=>r?[`${r.version}-${r.sha256}`]:[]));
    for(const name of names) {
      if(!/^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(name)||keep.has(name)||(s.phase==='waiting_idle'&&s.stableVersion&&name.startsWith(`${s.stableVersion}-`)))continue;
      await rm(join(root,name),{recursive:true,force:true}).catch(()=>{/* A binary still in use (Windows) is retried on the next pass. */});
    }
    for(const name of keep)for(const entry of await readdir(join(root,name)).catch(()=>[] as string[]))
      if(entry.endsWith('.partial')&&this.now()-(await stat(join(root,name,entry)).then(f=>f.mtimeMs,()=>this.now()))>3_600_000)await rm(join(root,name,entry),{force:true}).catch(()=>{});
  }
  async automatic():Promise<void> {
    await this.refreshLatest().catch(()=>undefined);
    if(!this.prunedOnce&&!this.busy){this.prunedOnce=true;this.busy=true;try{await this.prune();}catch{/* best effort */}finally{this.busy=false;}}
    const s=this.state();if(this.busy||s.mode!=='auto'||!this.store.canSafelyRestart()||this.store.snapshot().maintenanceDrain)return;
    if(this.now()<this.retryAfter)return;
    // A blocked or errored automatic channel retries on a schedule instead of waiting for someone to press "check".
    if(!s.error&&s.checkedAt&&this.now()-Date.parse(s.checkedAt)<6*60*60*1000&&s.phase!=='waiting_idle')return;
    await this.operate({action:'configure',provider:'claude',mode:'auto',expectedRevision:s.revision},`provider-auto-${randomUUID()}`,'automatic');
  }
}
