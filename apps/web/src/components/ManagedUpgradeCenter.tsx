import {useEffect,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight,Asterisk,Check,ChevronRight,Clock3,Monitor,RefreshCw,RotateCcw,ShieldCheck} from 'lucide-react';
import {api,type RuntimeReleaseStatus} from '../lib/api';
import type {Machine} from '../lib/types';
import type {ManagedChannel,ManagedProvider} from '../lib/managed-provider';
import {PROVIDER_NAMES} from '../lib/provider-catalog';
import {providerUpdateOffer} from '../lib/provider-updates';
import {runtimeRollout} from '../lib/runtime-rollout';
import {ManagedHostAction,managedVersion} from './ManagedHostAction';
import {type AgentReleaseStatus} from './HostUpdateStatus';
import {t,locale,systemText} from '../i18n';
import './ManagedUpgradeCenter.css';
import {ManagedConnectionAction} from './ManagedConnectionAction';

type Selection='codex'|'claude'|'grok'|'connection';
const names={...PROVIDER_NAMES,connection:'连接服务'};
const date=(at?:string|null)=>at?new Date(at).toLocaleString(locale()):t('尚未检查');
export function ManagedUpgradeCenter(){
  const [selected,setSelected]=useState<Selection>('codex');
  const [channels,setChannels]=useState<ManagedChannel[]>([]),[codex,setCodex]=useState<RuntimeReleaseStatus>(),[hosts,setHosts]=useState<Machine[]>([]),[agent,setAgent]=useState<AgentReleaseStatus>();
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[busy,setBusy]=useState('');
  const [confirm,setConfirm]=useState<{provider:ManagedProvider;action:'publish'|'rollback';revision:number;releaseId:string;version:string}|{provider:'codex';action:'rollback'}>();
  const lock=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();let reading=false;
    const refresh=async()=>{if(reading)return;reading=true;
      const results=await Promise.allSettled([api.managedReleases(controller.signal),api.runtimeRelease(controller.signal),api.managedHosts(controller.signal),api.agentReleaseStatus(controller.signal)]);
      if(!controller.signal.aborted){const [a,b,c,d]=results;if(a.status==='fulfilled')setChannels(a.value.channels);if(b.status==='fulfilled')setCodex(b.value);if(c.status==='fulfilled')setHosts(c.value);if(d.status==='fulfilled')setAgent(d.value);if(results.some(r=>r.status==='rejected'))setError(t('部分版本信息暂时无法读取，稍后会自动重试'));else setError('');setLoading(false);}reading=false;
    };void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{controller.abort();clearInterval(timer);};
  },[reload]);
  const channel=channels.find(c=>c.provider===selected);
  const target=selected==='codex'?codex?.target?.version:selected==='connection'?agent?.publicVersion:channel?.target?.version;
  const latest=selected==='codex'?codex?.latestVersion:selected==='connection'?agent?.expectedVersion:channel?.candidate?.version;
  const checking=selected==='codex'?['checking','downloading','validating'].includes(codex?.phase??''):channel?.phase==='checking';
  const checkedAt=selected==='codex'?codex?.lastCheckedAt:selected==='connection'?agent?.checkedAt:channel?.checkedAt;
  const matching=hosts.filter(m=>m.identity==='paired');
  const currentVersion=(m:Machine)=>selected==='connection'?m.agentVersion:selected==='codex'?m.codexVersion:managedVersion(m,selected);
  const isManaged=(m:Machine)=>selected==='connection'||(selected==='codex'?m.codexProfile?.source==='managed':selected==='grok'?Boolean(m.discovery?.managedGrokVersion):Boolean(m.discovery?.providerRuntimePolicy&&m.discovery.providerRuntimePolicy.mode!=='host'));
  const currentCount=target?matching.filter(m=>m.reachability==='live'&&currentVersion(m)===target&&isManaged(m)).length:0;
  async function act(key:string,work:()=>Promise<unknown>,message:string){if(lock.current)return;lock.current=true;setBusy(key);setError('');setNotice('');try{await work();setNotice(message);setConfirm(undefined);setReload(n=>n+1);}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy('');}}
  function check(){void act('check',()=>selected==='codex'?api.runtimeReleaseControl('check'):selected==='connection'?api.agentReleaseStatus():api.managedReleaseControl(selected,{action:'check'}),t('检查已提交，结果会自动更新'));}
  const switchTo=(id:Selection)=>{setSelected(id);setConfirm(undefined);setNotice('');};
  return <section className="managed-center" aria-label={t('托管升级')}>
    <header className="managed-center__intro"><div><span className="managed-eyebrow">AGENTFLEETS / {t('版本管理')}</span><h2>{t('托管版本')}</h2><p>{t('统一维护托管目标，在主机空闲时按需更新。')}</p></div><span className="managed-center__scope"><ShieldCheck size={15}/>{t('平台管理')}</span></header>
    <div className="managed-workspace">
      <nav className="managed-sidebar" aria-label={t('选择托管程序')}>
        <span className="managed-sidebar__label">{t('智能体')}</span>
        {(['codex','claude','grok'] as const).map(id=>{const version=id==='codex'?codex?.target?.version:channels.find(c=>c.provider===id)?.target?.version;return <button key={id} aria-current={selected===id?'page':undefined} onClick={()=>switchTo(id)}><span className={`managed-mark is-${id}`} aria-hidden="true">{id==='codex'?'C':id==='claude'?<Asterisk size={24}/>: 'G'}</span><span><strong>{names[id]}</strong><small>{version||t('尚未设置')}</small></span><ChevronRight size={14}/></button>;})}
        <span className="managed-sidebar__label is-separated">{t('主机服务')}</span>
        <button aria-current={selected==='connection'?'page':undefined} onClick={()=>switchTo('connection')}><span className="managed-mark"><Monitor size={18}/></span><span><strong>{t('连接服务')}</strong><small>{agent?.publicVersion||t('等待核验')}</small></span><ChevronRight size={14}/></button>
        <div className="managed-sidebar__later"><span>{t('后续接入')}</span><p>Qwen · Kimi<br/>Cursor · CodeBuddy</p></div>
      </nav>
      <div className="managed-content" aria-busy={loading}>
        <header className="managed-content__heading"><div><h3>{t(names[selected])}</h3><p>{selected==='connection'?t('主机连接与会话运行服务'):t('独立托管 · 保留主机账号与历史')}</p></div><button className="button button--quiet" disabled={Boolean(busy)||checking||selected==='codex'&&(!codex?.workerOnline||codex?.paused)} onClick={check}><RefreshCw size={14}/>{checking?t('检查中…'):t('检查新版')}</button></header>
        {loading?<div className="managed-loading" role="status">{t('正在读取托管版本…')}</div>:<>
          <div className="managed-release-line"><div><span>{selected==='connection'?t('已发布版本'):t('当前托管目标')}</span><strong>{target||'—'}</strong><small>{target?t('主机可选择更新到此版本'):t('发布后即可在主机上启用')}</small></div><ArrowRight className="managed-release-line__arrow" size={20}/><div><span>{selected==='connection'?t('发布目标'):t('发现的官方版本')}</span><strong>{latest||'—'}</strong><small>{selected==='codex'?(checking?t('正在验证'):codex?.phase==='blocked'?t('等待兼容适配'):t('以验证服务结果为准')):selected==='connection'?t('由平台发布'):channel?.candidate?t('发行清单已校验 · 主机启用前验证协议'):t('检查后显示可用版本')}</small></div></div>
          <div className="managed-channel-actions"><span className="managed-muted"><Clock3 size={13}/>{date(checkedAt)}</span><div>
            {channel?.candidate&&channel.candidate.id!==channel.target?.id&&<button className="button button--primary" disabled={Boolean(busy)||checking} onClick={()=>setConfirm({provider:channel.provider,action:'publish',revision:channel.revision,releaseId:channel.candidate!.id,version:channel.candidate!.version})}>{t('设为托管目标')}<ArrowUpRight size={14}/></button>}
            {channel?.previous&&<button className="managed-text-button" disabled={Boolean(busy)||checking} onClick={()=>setConfirm({provider:channel.provider,action:'rollback',revision:channel.revision,releaseId:channel.previous!.id,version:channel.previous!.version})}><RotateCcw size={13}/>{t('回退目标')}</button>}
            {selected==='codex'&&codex?.canControl&&<><button className="managed-text-button" disabled={Boolean(busy)} onClick={()=>void act('policy',()=>api.runtimeReleaseControl(codex.paused?'resume':'pause'),t('托管策略已保存'))}>{codex.paused?t('恢复自动晋升'):t('暂停自动晋升')}</button>{codex.previous&&<button className="managed-text-button" disabled={Boolean(busy)||!codex.workerOnline} onClick={()=>setConfirm({provider:'codex',action:'rollback'})}>{t('回退目标')}</button>}</>}
          </div></div>
          {confirm&&<div className="managed-confirm" role="group" aria-label={t('确认托管目标')}><strong>{t('确认变更托管目标')}</strong><p>{confirm.provider==='codex'?t('回退 Codex 托管目标并暂停自动晋升。现有回退策略将在主机空闲时应用。'):t('将 {0} 设为托管目标。各主机仍需手动确认更新。',confirm.version)}</p><div><button className="button button--primary" disabled={Boolean(busy)} onClick={()=>void act('publish',()=>confirm.provider==='codex'?api.runtimeReleaseControl('rollback'):api.managedReleaseControl(confirm.provider,{action:confirm.action,revision:confirm.revision,releaseId:confirm.releaseId}),t('托管目标变更已提交'))}>{t('确认')}</button><button className="managed-text-button" disabled={Boolean(busy)} onClick={()=>setConfirm(undefined)}>{t('取消')}</button></div></div>}
          {(channel?.error||selected==='codex'&&codex?.message)&&<p className="managed-channel-note" role="status">{systemText(channel?.error||codex?.message||'')}</p>}
          <section className="managed-hosts" aria-label={t('主机版本')}><header><h4>{t('工作区主机')}</h4><span>{t('{0} / {1} 台已使用目标版本',currentCount,matching.length)}</span></header>
            <div className="managed-hosts__columns"><span>{t('主机')}</span><span>{t('实际版本')}</span><span>{t('更新状态')}</span></div>
            {matching.map(machine=>{const offer=providerUpdateOffer('codex',machine,undefined,machine.codexVersion);const runtime=selected==='codex'?runtimeRollout(machine,codex?.target?.version,codex?.target?.schemaHash,Boolean(codex?.target)):undefined;return <article className="managed-host" key={machine.id}>
              <div className="managed-host__name"><span className={`managed-online ${machine.reachability==='live'?'is-live':''}`} aria-hidden="true"/><div><strong>{machine.displayAlias||machine.name}</strong><small>{machine.os} · {machine.arch} · {machine.reachability==='live'?t('在线'):t('离线')}</small></div></div>
              <div className="managed-host__version"><code>{currentVersion(machine)||'—'}</code><small>{selected==='connection'?t('连接服务'):selected==='codex'?machine.codexProfile?.source==='managed'?t('独立托管'):t('宿主机安装'):selected==='grok'?machine.discovery?.managedGrokVersion?t('独立托管'):t('宿主机安装'):machine.discovery?.providerRuntimePolicy?.mode&&machine.discovery.providerRuntimePolicy.mode!=='host'?t('独立托管'):t('宿主机安装')}</small></div>
              {selected==='claude'||selected==='grok'?<ManagedHostAction machine={machine} provider={selected} target={channel?.target} onAccepted={()=>setReload(n=>n+1)}/>:selected==='connection'?<ManagedConnectionAction machine={machine} release={agent}/>:<div className="managed-host-action">{offer?.kind==='codex-confirm'?<button className="button button--primary" disabled={Boolean(busy)||machine.reachability!=='live'} onClick={()=>void act(machine.id,()=>api.providerRuntimeOperation(machine.id,{action:'confirm',provider:'codex',version:offer.latest},crypto.randomUUID()),t('确认已提交，等待主机下载并切换'))}>{t('更新到 {0}',offer.latest)}</button>:<span className="managed-status">{runtime?.label===t('已运行当前托管目标')?<Check size={14}/>:null}{runtime?.label}</span>}{runtime?.error&&<small className="managed-error">{systemText(runtime.error)}</small>}</div>}
            </article>;})}
            {!matching.length&&<p className="managed-empty">{t('连接主机后，可在这里查看实际版本并更新。')}</p>}
          </section>
          <details className="managed-history"><summary>{t('验证详情与发布记录')}</summary>{selected==='codex'?<>{codex?.checks.map((c,i)=><p key={i}>{systemText(c.name)} · {systemText(c.detail)}</p>)}{codex?.history.map((h,i)=><p key={`h${i}`}>{date(h.at)} · {h.version} · {systemText(h.message)}</p>)}</>:selected==='connection'?<p>{t('安装包校验与启动验证通过后，主机才会报告更新完成。')}</p>:<><p>{selected==='claude'?t('核验官方签名清单；主机启用前核验 SDK 兼容性与启动协议。'):t('固定官方 npm 平台包及完整性摘要；主机启用前校验文件与 ACP 协议。')}</p><p>{t('支持的平台：{0}',Object.keys(channel?.target?.artifacts??channel?.candidate?.artifacts??{}).join(' · ')||'—')}</p>{channel?.history.map((h,i)=><p key={i}>{date(h.at)} · {h.version} · {h.action==='publish'?t('发布目标'):t('回退目标')}</p>)}</>}</details>
        </>}
        {error&&<p className="managed-feedback is-error" role="alert">{systemText(error)}</p>}{notice&&<p className="managed-feedback" role="status">{notice}</p>}
      </div>
    </div>
  </section>;
}
