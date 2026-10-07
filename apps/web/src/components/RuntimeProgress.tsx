import { useEffect, useState } from 'react';
import { Activity, FileCode2, Terminal, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';
import type { SessionProgress } from '../lib/types';
import { t } from '../i18n';

export function ProgressView({progress,unavailable=false}:{progress:SessionProgress;unavailable?:boolean}) {
  const latest=progress.items.at(-1);
  const live=progress.freshness==='live'&&!unavailable;
  const label=(kind:string)=>kind==='commandExecution'?t('执行命令'):kind==='fileChange'?t('修改文件'):kind==='plan'?t('计划进展'):t('过程说明');
  const Icon=latest?.kind==='commandExecution'?Terminal:latest?.kind==='fileChange'?FileCode2:MessageSquare;
  return <section className="runtime-progress" aria-label={t('运行进度')}>
    <header><Activity size={15}/><strong>{t('运行进度')}</strong><span>{unavailable?t('进度暂时无法更新'):live?t('实时更新'):t('最后已知进度')}</span></header>
    <div className="runtime-progress__current" role="status"><Icon size={15}/><span>{progress.waitingForApproval?t('等待你确认'):latest?`${label(latest.kind)} · ${latest.title||t('正在执行')}`:!progress.contentAvailable?t('未开启内容同步，仅显示运行状态'):t('等待新的过程事件')}</span></div>
    {progress.updatedAt&&<small>{t('最近更新')} · {new Date(progress.updatedAt).toLocaleTimeString()}</small>}
    {!!progress.items.length&&<details><summary>{t('查看最近过程')}</summary><ol>{progress.items.map(item=><li key={item.id}><div><strong>{label(item.kind)}</strong><span>{item.status==='completed'?t('已完成'):item.status==='failed'?t('失败'):item.status==='declined'?t('已拒绝'):live?t('执行中'):t('状态待确认')}</span></div><p>{item.title}</p>{item.output&&<pre>{item.output}</pre>}</li>)}</ol></details>}
    {progress.limited&&<small>{t('仅展示最近过程摘要，完整记录见消息历史')}</small>}
    {!live&&<small>{t('此处是已收到的事件，不代表任务已停止或完成')}</small>}
  </section>;
}

export function RuntimeProgress({sessionId,active,initial}:{sessionId:string;active:boolean;initial?:SessionProgress}) {
  const [progress,setProgress]=useState(initial);
  const [unavailable,setUnavailable]=useState(false);
  useEffect(()=>{setProgress(initial);},[initial]);
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const value=await api.sessionProgress(sessionId,controller.signal);
        if(!controller.signal.aborted&&value.sessionId===sessionId){setProgress(value);setUnavailable(false);}
      } catch {if(!controller.signal.aborted)setUnavailable(true);}
      if(!controller.signal.aborted)timer=setTimeout(poll,document.visibilityState==='hidden'?10000:2000);
    };
    void poll();return ()=>{controller.abort();clearTimeout(timer);};
  },[sessionId,active]);
  if(!active||!progress||progress.sessionId!==sessionId)return null;
  return <ProgressView progress={progress} unavailable={unavailable}/>;
}
