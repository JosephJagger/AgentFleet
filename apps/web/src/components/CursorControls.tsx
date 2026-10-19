import {useEffect,useRef,useState} from 'react';
import type {CursorSettings,CursorOption,CursorModel} from '../lib/cursor-settings';
import type {UsageSummary} from '../lib/usage';
import {api} from '../lib/api';
import {t} from '../i18n';

export function CursorControls({sessionId,settings,options,models,ready,supported,error,disabled,visible,observedAt,onReload,onSave}:{sessionId:string;settings:CursorSettings;options:CursorOption[];models:CursorModel[];ready:boolean;supported:boolean;error:string;disabled:boolean;visible:boolean;observedAt:string|null;onReload:()=>void;onSave:(s:CursorSettings)=>Promise<void>}){
  const [draft,setDraft]=useState(settings),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false),[message,setMessage]=useState('');
  const [usage,setUsage]=useState<UsageSummary>(),[usageError,setUsageError]=useState(false);
  useEffect(()=>{const times=usage?.accounts?.flatMap(a=>a.sharedSubscription?[Date.parse(a.sharedSubscription.expiresAt)]:[])??[];if(!times.length)return;
    const timer=window.setTimeout(()=>setUsage(u=>u?{...u,accounts:u.accounts.filter(a=>!a.sharedSubscription||Date.parse(a.sharedSubscription.expiresAt)>Date.now())}:u),Math.max(0,Math.min(...times)-Date.now())+1);return()=>window.clearTimeout(timer);
  },[usage]);
  const generation=useRef(0);
  useEffect(()=>{if(!dirty)setDraft(settings);},[settings,dirty]);
  useEffect(()=>{if(!visible)return;const controller=new AbortController();let pending=false;
    const read=async()=>{if(pending)return;pending=true;try{const u=await api.usage('session',sessionId,controller.signal,'cursor');if(!controller.signal.aborted){setUsage(u);setUsageError(false);}}catch{if(!controller.signal.aborted)setUsageError(true);}finally{pending=false;}};
    void read();const timer=window.setInterval(()=>{if(!document.hidden)void read();},30000);
    return()=>{controller.abort();window.clearInterval(timer);};
  },[sessionId,visible]);
  const model=draft.options?.model??options.find(o=>o.id==='model')?.current;
  const selected=models.find(m=>m.value===model);
  const different=model&&model!==options.find(o=>o.id==='model')?.current;
  const displayOptions=different?options.filter(o=>o.id==='mode'||o.id==='model').concat(selected?.configOptions??[]):options;
  const orderedOptions=[...displayOptions].sort((a,b)=>Number(b.id==='model')-Number(a.id==='model'));
  function change(id:string,value:string){
    let next={...draft.options};
    if(id==='model')next={...(next.mode?{mode:next.mode}:{})};
    if(value)next[id]=value;else delete next[id];
    generation.current++;setDraft({...draft,options:next});setDirty(true);setMessage('');
  }
  const locked=disabled||!ready||!supported||saving;
  async function save(){const gen=generation.current;setSaving(true);setMessage('');try{await onSave(draft);if(gen===generation.current){setDirty(false);setMessage(t('已保存，下一轮任务生效。'));}}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}
  return <>
    <details className="codex-settings-panel session-config-section" open><summary>{t('Cursor 模型与权限')}</summary>
      <p>{t('配置单独保存在此会话，下一轮发送时由 Cursor 原生接口确认后生效。正在执行的任务保持当前配置。')}</p>
      {!supported&&ready&&<p role="status">{t('请将此主机连接服务更新到 0.30.127 或更新版本。')}</p>}
      {!ready&&<p role="status">{t(error||'正在读取会话配置…')}</p>}
      <div className="claude-settings-fields codex-settings-fields">
        {orderedOptions.map(option=><label key={option.id}>{option.id==='model'?t('模型'):option.id==='mode'?t('任务模式'):option.name}<select aria-label={option.id==='model'?t('Cursor 模型'):option.id==='mode'?t('Cursor 任务模式'):option.name} value={draft.options?.[option.id]??''} disabled={locked} onChange={event=>change(option.id,event.target.value)}>
          <option value="">{t('沿用原生')}{option.current?` · ${option.values.find(v=>v.value===option.current)?.name??option.current}`:''}</option>
          {draft.options?.[option.id]&&!option.values.some(v=>v.value===draft.options?.[option.id])&&<option value={draft.options[option.id]}>{draft.options[option.id]} · {t('需重新选择')}</option>}
          {option.values.map(v=><option key={v.value} value={v.value}>{v.name}</option>)}
        </select></label>)}
        <label>{t('会话权限')}<select aria-label={t('Cursor 会话权限')} value={draft.permissionMode??'default'} disabled={locked} onChange={event=>{generation.current++;setDraft({...draft,permissionMode:event.target.value as CursorSettings['permissionMode']});setDirty(true);setMessage('');}}><option value="default">{t('原生审批，面板确认')}</option><option value="always">{t('允许本会话工具请求')}</option></select></label>
      </div>
      <p>{t('沿用 Cursor 主机上的权限规则与沙箱；本会话允许模式仅放行原生发到面板的工具审批，不修改全局允许列表。提问与计划仍需确认。')}</p>
      <small>{t('Cursor 原生切换也会记住主机端的默认模型；其他面板会话仍优先使用各自保存的模型。')}</small>
      {!options.some(o=>o.id==='mode')&&<p>{t('接管并同步原生会话后可读取任务模式及当前模型参数。')}</p>}
      {!displayOptions.some(o=>o.id==='model')&&<p>{t('主机尚未提供 Cursor 模型列表，可重新读取；不会使用其他智能体的模型列表。')}</p>}
      {observedAt&&<small>{t('原生配置更新于 {0}',new Date(observedAt).toLocaleString())}</small>}
      <div className="claude-settings-footer"><button type="button" className="button button--quiet" onClick={onReload}>{t('重新读取')}</button><button type="button" className="button button--quiet" disabled={saving||!dirty} onClick={()=>{setDraft(settings);setDirty(false);setMessage('');}}>{t('取消修改')}</button><button type="button" className="button button--primary" disabled={locked||!dirty} onClick={()=>void save()}>{t(saving?'保存中…':'保存')}</button></div>
      {message&&<p role="status">{message}</p>}
    </details>
    <details className="session-config-section" open><summary>{t('会话消耗与剩余额度')}</summary>
      {usageError?<p role="alert">{t('用量读取失败，请重新打开会话配置。')}</p>:!usage?<p>{t('正在读取用量…')}</p>:<>
        <p>{t('已记录消耗')}：{usage.recorded?`${usage.recorded.totalTokens.toLocaleString()} tokens`:t('原生未上报')}</p>
        {usage.last&&<p>{t('最近一轮消耗')}：{usage.last.totalTokens.toLocaleString()} tokens</p>}
        {usage.accounts?.filter(a=>a.sharedSubscription&&Date.parse(a.sharedSubscription.expiresAt)>Date.now()).map((a,i)=><div className="usage-account" key={i}>
          <p>{t('共享订阅额度 · 来源：Grok 原生账单，已核对 Cursor 与 Grok 账号。')}</p>
          {a.windows.map(w=><div key={w.window}><p>{t('已用 {0}% · 剩余 {1}%',w.usedPercent,w.remainingPercent)}</p><progress max={100} value={w.usedPercent} aria-label={t('额度已用比例')}/><p>{w.resetsAt?t('重置于 {0}',new Date(w.resetsAt*1000).toLocaleString()):t('重置时间未上报')}</p></div>)}
          <small>{a.sourceMachine} · {t('更新于 {0}',new Date(a.observedAt).toLocaleString())}</small>
        </div>)}
        {!usage.accounts?.some(a=>a.sharedSubscription&&Date.parse(a.sharedSubscription.expiresAt)>Date.now())&&<p>{t('未确认 Cursor 与 Grok 属于同一共享订阅账号，暂不显示共享额度。')}</p>}
        {usage.lastObservedAt&&<small>{t('用量更新于 {0}',new Date(usage.lastObservedAt).toLocaleString())}</small>}
        <p>{t('用量只统计实际收到的原生数据，不估算未上报的历史，也不将上下文占用视为计费消耗。额度是账号共享数据，不能在会话中修改。')}</p>
      </>}
    </details>
  </>;
}
