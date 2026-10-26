import { useEffect, useRef, useState } from 'react';
import { Package, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { PROVIDER_NAMES, type ProviderId } from '../lib/provider-catalog';
import type { ProviderRuntimeRequest, ProviderRuntimeState } from '../lib/provider-runtime-policy';
import { providerUpdateOffer } from '../lib/provider-updates';
import type { HostOperation, Machine } from '../lib/types';
import { t, systemText } from '../i18n';
import { HostDisclosure } from './HostDisclosure';
import './HostProviderVersions.css';
type VersionRow={version?:string|null;hostVersion?:string|null;source?:string;compatibility?:string;sdkVersion?:string;installed?:boolean};
type Report={checkedAt:string;providers:Partial<Record<ProviderId,VersionRow>> & {claude?:VersionRow & ProviderRuntimeState}};
const order:ProviderId[]=['codex','claude','cursor','qwen','kimi','codebuddy','grok'];
function reportOf(o?:HostOperation):Report|undefined {const r=o?.result;return r&&typeof r.checkedAt==='string'&&r.providers&&typeof r.providers==='object'?r as Report:undefined;}
export function HostProviderVersions({machine,canConfirmCodex=false}:{machine:Machine;canConfirmCodex?:boolean}) {
  const [operation,setOperation]=useState<HostOperation>();const [report,setReport]=useState<Report>();const [error,setError]=useState('');const [sending,setSending]=useState(false);const submitting=useRef(false);
  const [mode,setMode]=useState<ProviderRuntimeState['mode']>('host');
  const supported=machine.maintenanceCapabilities?.includes('provider.runtime');
  const pending=sending||Boolean(operation&&['accepted','running','unknown'].includes(operation.state));
  const live=machine.discovery?.providerRuntimePolicy;
  const checked=report?.providers.claude;
  const policy=live&&(!checked||live.revision>=checked.revision)?live:checked;
  useEffect(()=>{setMode(policy?.mode??'host');},[policy?.mode,policy?.revision]);
  useEffect(()=>{const c=new AbortController();void api.hostOperations(machine.id,c.signal).then(rows=>{if(c.signal.aborted)return;const ops=rows.filter(o=>o.type==='provider.runtime');setOperation(ops[0]);setReport(ops.map(reportOf).find(Boolean));}).catch(e=>{if(!c.signal.aborted)setError((e as Error).message);});return()=>c.abort();},[machine.id]);
  useEffect(()=>{
    if(!operation||!['accepted','running','unknown'].includes(operation.state))return;
    let disposed=false,inflight=false;
    const poll=async()=>{if(inflight)return;inflight=true;try{const next=await api.readHostOperation(operation.id);if(!disposed){setOperation(next);const result=reportOf(next);if(result)setReport(result);setError(next.error?.message??'');}}catch(e){if(!disposed)setError((e as Error).message);}finally{inflight=false;}};
    const timer=setInterval(()=>void poll(),3000);void poll();return()=>{disposed=true;clearInterval(timer);};
  },[operation?.id,operation?.state]);
  const operate=async(request:ProviderRuntimeRequest)=>{
    if(submitting.current||pending||!supported||machine.reachability!=='live')return;
    submitting.current=true;setSending(true);setError('');
    try{const next=await api.providerRuntimeOperation(machine.id,request,crypto.randomUUID());setOperation(next);const result=reportOf(next);if(result)setReport(result);}
    catch(e){setError((e as Error).message);}finally{submitting.current=false;setSending(false);}
  };
  return <HostDisclosure title={t('智能体版本管理')} description={t('查看实际版本、兼容状态与更新方式')} icon={<Package size={20}/>} className="provider-versions">
    <p className="subtle">{t('默认沿用宿主机安装。协议检查不等于完整任务验证，账号和历史仍保留在原主机。')}</p>
    <div className="provider-versions__list">{order.map(id=>{
      const reported=report?.providers[id];const native=id==='codex'?{version:machine.codexVersion,installed:true}:machine.agentRuntimes?.[id];
      const row=reported??native;const source=id==='codex'?String(machine.codexProfile?.source??''):id==='claude'?policy?.mode==='host'||!policy?'host':'managed':'host';
      // Codex's active version is refreshed by heartbeats; inventory reports are historical snapshots.
      const version=id==='codex'?machine.codexVersion||reported?.version:id==='claude'&&policy?.mode!=='host'&&policy?.current?policy.current.version:row?.version;
      const compatibility=id==='codex'?machine.compatibility:reported?.compatibility;
      // Codex rollout and validation status belong to the platform administrator; everyone else only sees the version.
      const codexVisible=id!=='codex'||canConfirmCodex;
      const offer=codexVisible?providerUpdateOffer(id,machine,policy,id==='codex'?machine.codexVersion:version):undefined;
      const canAct=supported&&!pending&&machine.reachability==='live';
      return <div className="provider-versions__row" key={id}><div><strong>{PROVIDER_NAMES[id]}</strong><span>{version|| (row?.installed===false?t('未安装'):t('尚未上报'))}</span></div>{codexVisible&&<div><span>{source==='managed'?t('独立托管'):source==='host'?t('宿主机安装'):t('尚未上报')}</span><small>{compatibility==='compatible'?t('已通过兼容验证'):compatibility==='protocol_checked'?t('协议检查通过'):t('待验证')}</small></div>}
        {offer&&<div className="provider-versions__offer" role="status">
          {offer.kind==='codex-confirm'?<><span>{t('{0} 已通过验证，确认后才会更新',offer.latest)}</span><button className="button button--primary" type="button" disabled={!canAct} onClick={()=>void operate({action:'confirm',provider:'codex',version:offer.latest})}>{t('确认更新到 {0}',offer.latest)}</button></>
          :offer.kind==='claude-update'?<><span>{t('官方稳定版 {0} 可用',offer.latest)}</span><button className="button button--primary" type="button" disabled={!canAct||!policy} onClick={()=>{if(policy)void operate({action:'update',provider:'claude',expectedRevision:policy.revision});}}>{t('更新到 {0}',offer.latest)}</button></>
          :<span>{t('有新版本 {0}，请用原安装方式更新',offer.latest)}</span>}
        </div>}
      </div>;
    })}</div>
    <div className="provider-versions__actions"><button className="button button--secondary" disabled={!supported||pending||machine.reachability!=='live'} onClick={()=>void operate({action:'check'})}><RefreshCw size={15}/>{pending?t('正在检查或应用…'):t('检查智能体版本')}</button>{report&&<small>{t('上次检查：{0}',new Date(report.checkedAt).toLocaleString())}</small>}</div>
    {!supported?<p role="status">{t('更新连接服务后可管理智能体版本。')}</p>:<form className="provider-versions__policy" onSubmit={e=>{e.preventDefault();if(policy)void operate({action:'configure',provider:'claude',mode,expectedRevision:policy.revision});}}>
      <label>{t('Claude Code 更新方式')}<select aria-label={t('Claude Code 更新方式')} value={mode} onChange={e=>setMode(e.target.value as ProviderRuntimeState['mode'])} disabled={pending}><option value="host">{t('沿用宿主机安装')}</option><option value="pinned">{t('托管 · 固定版本')}</option><option value="auto">{t('托管 · 自动更新稳定版')}</option></select></label>
      <p className="subtle">{t('托管会下载独立版本，不覆盖系统安装；先核验 SDK 与协议，任务和通话结束后才切换。失败保留原版本，回退后暂停自动更新。')}</p>
      {policy?.stableVersion&&<small>{t('官方稳定版：{0} · SDK：{1}',policy.stableVersion,checked?.sdkVersion??'—')}</small>}
      <div className="provider-versions__actions"><button className="button button--primary" type="submit" disabled={!policy||pending||machine.reachability!=='live'}>{t('应用更新方式')}</button><button className="button button--quiet" type="button" disabled={!policy?.previous||pending||machine.reachability!=='live'} onClick={()=>policy&&void operate({action:'rollback',provider:'claude',expectedRevision:policy.revision})}>{t('回退并固定版本')}</button></div>
      {policy?.step==='downloading'&&<p role="status">{policy.progress?t('正在下载官方 Claude Code {0}：{1} / {2} MB（{3}%），期间可继续使用，不影响任务。',policy.stableVersion??'',(policy.progress.received/1048576).toFixed(0),(policy.progress.total/1048576).toFixed(0),Math.floor(100*policy.progress.received/policy.progress.total)):t('正在下载官方 Claude Code，期间可继续使用，不影响任务。')}</p>}
      {policy?.step==='verifying'&&<p role="status">{t('下载完成，正在校验文件并做兼容检查…')}</p>}
      {policy?.phase==='waiting_idle'&&<p role="status">{t('已验证目标，等待任务或通话结束后再应用。')}</p>}
      {policy?.error&&<p role="status">{systemText(policy.error)}</p>}
      <p className="subtle">{t('发现新版本只作提示：Codex 与托管的 Claude Code 经你确认后才会更新；其他智能体仍由原安装方式更新，本页不会修改其安装或自动更新设置。')}</p>
    </form>}
    {error&&<p role="alert">{systemText(error)}</p>}
    {operation?.state==='unknown'&&<p role="status">{t('操作结果待核验，请勿重复提交。')}</p>}
  </HostDisclosure>;
}
