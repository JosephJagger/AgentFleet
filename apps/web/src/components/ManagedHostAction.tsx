import {useEffect,useRef,useState} from 'react';
import {Download,Check,LoaderCircle} from 'lucide-react';
import {api} from '../lib/api';
import type {HostOperation,Machine} from '../lib/types';
import type {ManagedProvider,ManagedRelease,ManagedPhase} from '../lib/managed-provider';
import {managedHostPlatform,managedVersionNumber} from '../lib/managed-host';
import {isNewerVersion} from '../lib/provider-updates';
import {t,systemText} from '../i18n';

export const managedPhaseLabel=(phase:ManagedPhase)=>({accepted:t('已接受，等待准备'),downloading:t('正在下载'),verifying:t('正在校验'),waiting_idle:t('等待任务和通话结束'),activating:t('正在切换并验证启动'),succeeded:t('更新完成'),failed:t('更新失败，保留原版本'),cancelled:t('更新已取消'),unknown:t('结果待核验')})[phase];
export function managedVersion(machine:Machine,provider:ManagedProvider){
  if(provider==='grok')return managedVersionNumber(machine.agentRuntimes?.grok?.version??machine.discovery?.managedGrokVersion);
  const policy=machine.discovery?.providerRuntimePolicy;
  return managedVersionNumber(machine.agentRuntimes?.claude?.version??(policy&&policy.mode!=='host'?policy.current?.version:undefined));
}
export function ManagedHostAction({machine,provider,target,onAccepted}:{machine:Machine;provider:ManagedProvider;target?:ManagedRelease;onAccepted?:()=>void}) {
  const [sending,setSending]=useState(false),[error,setError]=useState(''),[accepted,setAccepted]=useState<number>();
  const inFlight=useRef(false);
  const [operation,setOperation]=useState<HostOperation>();
  const [policyAccepted,setPolicyAccepted]=useState<number>();
  const [claudeOption,setClaudeOption]=useState<'host'|'pinned'|'rollback'>();
  const policy=machine.discovery?.providerRuntimePolicy;
  useEffect(()=>{
    if(!operation)return;
    if(['failed','expired'].includes(operation.state)){setAccepted(undefined);setPolicyAccepted(undefined);setError(operation.error?.message??t('操作未完成'));return;}
    if(operation.state==='succeeded')return;
    const controller=new AbortController();let reading=false;
    const refresh=async()=>{if(reading)return;reading=true;try{const next=await api.readHostOperation(operation.id,controller.signal);if(!controller.signal.aborted){setOperation(next);if(next.state==='unknown')setError(t('操作结果待核验，请勿重复提交。'));}}catch{if(!controller.signal.aborted)setError(t('操作记录暂时无法读取'));}finally{reading=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{controller.abort();clearInterval(timer);};
  },[operation?.id,operation?.state]);
  const [rollback,setRollback]=useState(false);
  const job=machine.discovery?.managedUpdates?.[provider];
  const active=Boolean(job&&['accepted','downloading','verifying','waiting_idle','activating'].includes(job.phase));
  const managed=provider==='grok'?Boolean(machine.discovery?.managedGrokVersion):Boolean(machine.discovery?.providerRuntimePolicy&&machine.discovery.providerRuntimePolicy.mode!=='host');
  const version=managedVersion(machine,provider),current=managed&&target&&version===target.version;
  const platform=managedHostPlatform(machine);
  const supported=Boolean(target&&platform&&(target.artifacts[platform]||target.artifacts[`${platform}-musl`]));
  const submit=async(cancel=false,revert=false)=>{
    if(inFlight.current)return;inFlight.current=true;setSending(true);setError('');
    try{const operation=await api.providerRuntimeOperation(machine.id,revert?{action:'rollback-managed',provider:'grok',expectedRevision:job?.revision??0}:cancel?{action:'cancel-managed',provider,expectedRevision:job?.revision??0}:{action:'install-managed',provider,releaseId:target!.id,expectedRevision:job?.revision??0},crypto.randomUUID());setOperation(operation);setAccepted((job?.revision??0)+1);setRollback(false);onAccepted?.();}
    catch(e){setError((e as Error).message);}finally{inFlight.current=false;setSending(false);}
  };
  const submitClaude=async()=>{
    if(inFlight.current||!policy||!claudeOption)return;inFlight.current=true;setSending(true);setError('');
    try{const next=await api.providerRuntimeOperation(machine.id,claudeOption==='rollback'?{action:'rollback',provider:'claude',expectedRevision:policy.revision}:{action:'configure',provider:'claude',mode:claudeOption,expectedRevision:policy.revision},crypto.randomUUID());setOperation(next);setPolicyAccepted(policy.revision+1);setClaudeOption(undefined);onAccepted?.();}
    catch(e){setError((e as Error).message);}finally{inFlight.current=false;setSending(false);}
  };
  const awaiting=(accepted!==undefined&&(!job||job.revision<accepted))||(policyAccepted!==undefined&&(!policy||policy.revision<policyAccepted));
  const operationPending=Boolean(operation&&['accepted','running','unknown'].includes(operation.state));
  const disabled=sending||awaiting||operationPending;
  return <div className="managed-host-action">
    {active&&job?<><span className="managed-status" role="status"><LoaderCircle size={14}/>{managedPhaseLabel(job.phase)}</span>{job.total&&job.received!==undefined?<progress aria-label={t('下载进度')} value={job.received} max={job.total}/>:null}{job.phase!=='activating'&&<button className="managed-text-button" disabled={disabled||machine.reachability!=='live'} onClick={()=>void submit(true)}>{t('取消更新')}</button>}</>
    :machine.reachability!=='live'?<span className="managed-muted">{t('离线 · 等待连接')}</span>
    :!machine.discovery?.managedProviderSupport?<span className="managed-muted">{t('请先更新连接服务')}</span>
    :current?<span className="managed-status is-current"><Check size={14}/>{t('已是托管目标')}</span>
    :job?.phase==='succeeded'&&job.targetVersion===target?.version&&version!==job.targetVersion?<span className="managed-muted">{t('等待实际版本上报')}</span>
    :!target?<span className="managed-muted">{t('尚未发布托管版本')}</span>
    :!supported?<span className="managed-muted">{t('当前系统暂不支持')}</span>
    :isNewerVersion(version,target.version)?<span className="managed-muted">{t('当前版本高于托管目标')}</span>
    :<button className="button button--primary managed-install" disabled={disabled} onClick={()=>void submit()}><Download size={14}/>{sending?t('正在提交…'):managed?t('更新到 {0}',target.version):t('启用托管 {0}',target.version)}</button>}
    {(awaiting||operationPending)&&!active&&<small role="status">{t('请求已提交，等待主机上报进度')}</small>}
    {job&&!active&&['failed','unknown','cancelled'].includes(job.phase)&&<small className={job.phase==='failed'?'managed-error':'managed-muted'}>{job.error?systemText(job.error):managedPhaseLabel(job.phase)}</small>}
    {provider==='grok'&&machine.discovery?.managedGrokPrevious&&!active&&machine.reachability==='live'&&<>
      {rollback?<span className="managed-rollback"><span>{t('回退到 {0}？',machine.discovery.managedGrokPrevious)}</span><button className="managed-text-button" disabled={disabled} onClick={()=>void submit(false,true)}>{t('确认回退')}</button><button className="managed-text-button" onClick={()=>setRollback(false)}>{t('取消')}</button></span>:<button className="managed-text-button" disabled={disabled} onClick={()=>setRollback(true)}>{t('回退版本')}</button>}
    </>}
    {provider==='claude'&&policy&&machine.discovery?.managedProviderSupport&&policy.mode!=='host'&&!active&&<details className="managed-host-options"><summary>{t('版本选项')}</summary>
      <span className="managed-muted">{policy.mode==='auto'?t('已开启 Claude 独立自动更新'):t('已固定当前托管版本')}</span>
      {claudeOption?<div className="managed-rollback"><span>{claudeOption==='rollback'?t('回退到 {0}？',policy.previous?.version??''):claudeOption==='host'?t('切换回宿主机安装？'):t('固定当前版本并停止自动更新？')}</span><button className="managed-text-button" disabled={disabled||machine.reachability!=='live'} onClick={()=>void submitClaude()}>{t('确认')}</button><button className="managed-text-button" onClick={()=>setClaudeOption(undefined)}>{t('取消')}</button></div>:<>
        {policy.mode==='auto'&&<button className="managed-text-button" disabled={disabled||machine.reachability!=='live'} onClick={()=>setClaudeOption('pinned')}>{t('固定当前版本')}</button>}
        {policy.previous&&<button className="managed-text-button" disabled={disabled||machine.reachability!=='live'} onClick={()=>setClaudeOption('rollback')}>{t('回退版本')}</button>}
        <button className="managed-text-button" disabled={disabled||machine.reachability!=='live'} onClick={()=>setClaudeOption('host')}>{t('切回宿主机安装')}</button>
      </>}
    </details>}
    {error&&<small role="alert" className="managed-error">{systemText(error)}</small>}
  </div>;
}
