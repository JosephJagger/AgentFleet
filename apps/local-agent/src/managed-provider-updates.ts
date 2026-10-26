import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {StateStore} from './store.js';
import {AgentError} from './errors.js';
import {parseManagedRelease,type ManagedProvider,type ManagedUpdate,type ManagedRelease,type ManagedPhase} from './managed-provider.js';
import type {ManagedProviderRequest} from './provider-runtime-policy.js';
import {ProviderRuntimeManager,newerVersion} from './provider-runtime-manager.js';
import {detectAcp,type AcpExecutable} from './acp-providers.js';
import {prepareGrok,probeGrok,verifyGrok,type GrokInstallation} from './managed-grok.js';

export interface ManagedJob extends ManagedUpdate {release:ManagedRelease;createdAt:string;rollback?:boolean;policyRevision?:number;prepared?:GrokInstallation;}
const pending=(phase:ManagedPhase)=>['accepted','downloading','verifying','waiting_idle','activating'].includes(phase);
const defaults={prepareGrok,probeGrok,verifyGrok,detectAcp};
/** Durable manual intent. Idle waits resume; interrupted activation never reports success or silently replays. */
export class ManagedProviderUpdates {
  private readonly active=new Map<ManagedProvider,{controller:AbortController;work:Promise<void>}>();
  private readonly submitting=new Set<ManagedProvider>();
  private timer:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  constructor(private readonly store:StateStore,private readonly claude:ProviderRuntimeManager,
    private readonly target:(provider:ManagedProvider)=>Promise<ManagedRelease>,private readonly activateGrok:()=>Promise<void>,
    private readonly changed:()=>void,private readonly deps=defaults) {}
  status(){return Object.fromEntries(Object.entries(this.store.snapshot().managedUpdates??{}).map(([id,job])=>{
    const {release:_,prepared:__,createdAt:___,rollback:____,policyRevision:_____,...status}=job;return [id,status];
  }));}
  async start(){
    await this.store.update(s=>{for(const job of Object.values(s.managedUpdates??{}))if(pending(job.phase)&&job.phase!=='waiting_idle'){
      job.phase='unknown';job.error='更新被中断，请检查实际版本后重试';job.updatedAt=new Date().toISOString();
      if(s.maintenanceDrain?.operationId===job.operationId)delete s.maintenanceDrain;
    }});
    this.timer=setInterval(()=>this.tick(),5000);this.timer.unref();this.tick();
  }
  async stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);for(const a of this.active.values())a.controller.abort();await Promise.allSettled([...this.active.values()].map(a=>a.work));}
  async detectGrok():Promise<AcpExecutable|null>{
    const installed=this.store.snapshot().managedGrok?.current;
    if(!installed)return this.deps.detectAcp('grok');
    return {executable:await this.deps.verifyGrok(this.store.dataDir,installed),prefix:[],version:installed.release.version};
  }
  async request(request:ManagedProviderRequest,operationId:string) {
    const provider=request.provider;
    if(this.submitting.has(provider))throw new AgentError('PROVIDER_UPDATE_BUSY','更新请求正在提交');
    this.submitting.add(provider);
    try {
      const previous=this.store.snapshot().managedUpdates?.[provider];
      if((previous?.revision??0)!==request.expectedRevision)throw new AgentError('PROVIDER_POLICY_CONFLICT','更新状态已变化，请刷新后重试');
      if(request.action==='cancel-managed') {
        if(!previous||!pending(previous.phase)||previous.phase==='activating')throw new AgentError('PROVIDER_CANCEL_UNAVAILABLE','当前阶段不能取消');
        this.active.get(provider)?.controller.abort();
        await this.patch(provider,{phase:'cancelled',revision:previous.revision+1,error:''});return;
      }
      if(this.active.has(provider)||(previous&&pending(previous.phase)))throw new AgentError('PROVIDER_UPDATE_BUSY','此智能体已有更新正在进行');
      const rollback=request.action==='rollback-managed';
      const retained=rollback?this.store.snapshot().managedGrok?.previous:undefined;
      if(rollback&&!retained)throw new AgentError('PROVIDER_NO_ROLLBACK','没有保留的 Grok 托管版本');
      const release=retained?.release??await this.target(provider);
      if(request.action==='install-managed'&&release.id!==request.releaseId)throw new AgentError('PROVIDER_TARGET_CHANGED','托管目标已变化，请重新确认');
      const at=new Date().toISOString();
      await this.store.update(s=>{s.managedUpdates??={};s.managedUpdates[provider]={provider,release,releaseId:release.id,targetVersion:release.version,revision:request.expectedRevision+1,operationId,phase:'accepted',createdAt:at,updatedAt:at,rollback,policyRevision:this.claude.state().revision,...(retained?{prepared:retained}:{})};});
      this.changed();this.launch(provider);
    } finally {this.submitting.delete(provider);}
  }
  private async pruneGrok(){
    const state=this.store.snapshot();const keep=new Set([state.managedGrok?.current,state.managedGrok?.previous,state.managedUpdates?.grok?.prepared].flatMap(i=>i?[`${i.release.version}-${i.release.id}`]:[]));
    const root=join(this.store.dataDir,'provider-runtimes','grok');
    for(const name of await readdir(root).catch(()=>[] as string[]))if(/^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(name)&&!keep.has(name))await rm(join(root,name),{recursive:true,force:true}).catch(()=>undefined);
  }
  private tick(){if(this.stopped)return;for(const id of ['claude','grok'] as const)if(this.store.snapshot().managedUpdates?.[id]?.phase==='waiting_idle'&&this.store.canSafelyRestart())this.launch(id);}
  private launch(provider:ManagedProvider){
    if(this.stopped||this.active.has(provider))return;
    const controller=new AbortController();
    const work=Promise.resolve().then(()=>this.run(provider,controller.signal)).finally(()=>this.active.delete(provider));
    this.active.set(provider,{controller,work});
    void work.catch(()=>undefined);
  }
  private async patch(provider:ManagedProvider,patch:Partial<ManagedJob>){await this.store.update(s=>{const j=s.managedUpdates?.[provider];if(j&&j.phase!=='cancelled')Object.assign(j,patch,{updatedAt:new Date().toISOString()});});this.changed();}
  private async run(provider:ManagedProvider,signal:AbortSignal){
    const job=this.store.snapshot().managedUpdates?.[provider];if(!job||!pending(job.phase))return;
    const assertCurrent=async()=>{signal.throwIfAborted();if((job.rollback?this.store.snapshot().managedGrok?.previous?.release.id:(await this.target(provider)).id)!==job.releaseId)throw new AgentError('PROVIDER_TARGET_CHANGED','托管目标已变化，请重新确认');signal.throwIfAborted();};
    let admitted=false;
    try {
      if(Date.now()-Date.parse(job.createdAt)>24*60*60_000)throw new AgentError('PROVIDER_CONFIRM_EXPIRED','更新确认已过期，请重新确认');
      await assertCurrent();
      if(provider==='claude') {
        if(job.policyRevision!==this.claude.state().revision)throw new AgentError('PROVIDER_POLICY_CONFLICT','Claude 设置已变化，请重新确认更新');
        await this.claude.operate({action:'configure',provider:'claude',mode:'pinned',expectedRevision:this.claude.state().revision},job.operationId,'manual',{
          release:job.release,signal,assertCurrent,phase:phase=>this.patch(provider,{phase}),
        });
        if(this.claude.state().current?.version!==job.targetVersion||this.claude.state().mode==='host')throw new AgentError('PROVIDER_VERSION_MISMATCH','当前 Claude 版本尚未切换到目标');
      } else {
        const prior=this.store.snapshot().managedGrok;
        const installed=prior?.current?.release.version??(await this.deps.detectAcp('grok'))?.version?.match(/\d+\.\d+\.\d+/)?.[0];
        if(!job.rollback&&installed&&newerVersion(installed,job.targetVersion))throw new AgentError('PROVIDER_HOST_NEWER','当前 Grok 比托管目标更新，未执行降级');
        let prepared=job.prepared;
        if(prepared)try{await this.deps.verifyGrok(this.store.dataDir,prepared);}catch{prepared=undefined;}
        if(!prepared){await this.patch(provider,{phase:'downloading'});prepared=await this.deps.prepareGrok(this.store.dataDir,job.release,signal,(received,total)=>{void this.patch(provider,{received,total}).catch(()=>undefined);});await this.patch(provider,{prepared});}
        await this.patch(provider,{phase:'verifying'});
        const binary=await this.deps.verifyGrok(this.store.dataDir,prepared);
        await this.deps.probeGrok(binary,job.targetVersion,signal);await assertCurrent();
        admitted=await this.store.tryBeginUpdate(job.operationId);
        if(!admitted){await this.patch(provider,{phase:'waiting_idle'});return;}
        signal.throwIfAborted();await this.patch(provider,{phase:'activating'});
        await this.store.update(s=>{signal.throwIfAborted();if(s.managedUpdates?.grok?.phase!=='activating')throw new Error('Update cancelled');s.managedGrok={current:prepared!,...(prior?.current?{previous:prior.current}:{})};});
        try{await this.activateGrok();}
        catch(error){await this.store.update(s=>{if(prior)s.managedGrok=prior;else delete s.managedGrok;});await this.activateGrok().catch(()=>undefined);throw error;}
      }
      await this.patch(provider,{phase:'succeeded',error:''});
      if(provider==='grok')await this.pruneGrok().catch(()=>undefined);
    } catch(error) {
      if(this.store.snapshot().managedUpdates?.[provider]?.phase==='cancelled')return;
      const waiting=error instanceof AgentError&&error.code==='PROVIDER_HOST_BUSY';
      await this.patch(provider,{phase:this.stopped?'unknown':waiting?'waiting_idle':'failed',error:waiting?'':error instanceof AgentError?error.message:'版本校验或启用失败，保留原版本'});
    } finally {if(admitted)await this.store.finishUpdateAdmission(job.operationId);}
  }
}
export async function fetchManagedTarget(origin:string,provider:ManagedProvider):Promise<ManagedRelease>{
  const r=await fetch(`${origin.replace(/\/$/,'')}/api/managed-releases/${provider}/target`,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok||!r.body)throw new AgentError('PROVIDER_TARGET_UNAVAILABLE','暂时无法读取托管目标');
  const chunks:Uint8Array[]=[];let size=0;for await(const chunk of Readable.fromWeb(r.body as import("node:stream/web").ReadableStream)){size+=chunk.length;if(size>32000)throw new Error('Target too large');chunks.push(chunk);}
  const target=parseManagedRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')).target);
  if(target.provider!==provider)throw new Error('Target provider mismatch');return target;
}
