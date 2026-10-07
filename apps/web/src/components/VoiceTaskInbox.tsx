import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import type {VoiceTaskPage,VoiceTaskRecord} from '../lib/types';
import {t} from '../i18n';

/** Server memory is independent of the call lifecycle. Opening it never dispatches work. */
export function VoiceTaskInbox({onOpenSession}:{onOpenSession:(id:string)=>void}) {
 const [expanded,setExpanded]=useState(false),[view,setView]=useState('recover'),[cursor,setCursor]=useState<string|undefined>();
 const [trail,setTrail]=useState<(string|undefined)[]>([]),[page,setPage]=useState<VoiceTaskPage>(),[revision,setRevision]=useState(0);
 const [error,setError]=useState(''),[busy,setBusy]=useState<string|null>(null);
 useEffect(()=>{
  if(!expanded)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const value=await api.voiceTasks(view,cursor,controller.signal);if(!controller.signal.aborted){setPage(value);setError('');}}catch{if(!controller.signal.aborted)setError(t('语音任务记录暂时无法读取，请重试'));}
   if(!controller.signal.aborted)timer=setTimeout(load,10000);};
  setPage(undefined);void load();return()=>{controller.abort();clearTimeout(timer);};
 },[expanded,view,cursor,revision]);
 const act=async(record:VoiceTaskRecord,kind:'cancel'|'ack')=>{
  if(busy)return;setBusy(record.todoId);
  try{if(kind==='cancel')await api.cancelVoiceTodo(record.todoId,record.revision);else await api.acknowledgeVoiceTodo(record.todoId);setRevision(value=>value+1);}
  catch{setError(t('记录已变化或操作失败，请刷新后重试'));}finally{setBusy(null);}
 };
 return <section className="voice-task-inbox">
  <button className="button button--secondary" type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{t('待办与结果记录')}</button>
  {expanded&&<>
   <p>{t('记录保存在服务端，挂断后仍保留。恢复只读取记录，不会自动执行。')}</p>
   <label>{t('查看记录')}<select value={view} onChange={e=>{setView(e.target.value);setCursor(undefined);setTrail([]);}}><option value="recover">{t('待处理与未确认结果')}</option><option value="all">{t('全部记录')}</option></select></label>
   {error&&<p role="alert">{error}</p>}
   <button className="button button--secondary" type="button" onClick={()=>setRevision(value=>value+1)}>{t('刷新记录')}</button>
   {!page&&!error&&<p role="status">{t('正在读取记录')}</p>}
   {page?.items.length===0&&<p>{t('暂无语音任务记录')}</p>}
   <div className="voice-task-inbox__records">{page?.items.map(record=>{
    const finished=record.job&&['completed','failed','interrupted'].includes(record.job.state);
    const state=record.state==='completed'?t('手动续办已完成'):record.state==='pending'?t('待确认，尚未派发'):record.state==='cancelled'?t('已取消'):record.job?.state==='completed'?t('已完成'):record.job?.state==='failed'?t('失败'):record.job?.state==='interrupted'?t('已停止'):record.job?.state==='submitted'?t('等待主机'):record.job?.state==='running'?t('执行中'):t('状态待确认');
    return <article key={record.todoId} className="panel-voice-control__task"><strong>{state}</strong><p>{record.intent||t('原始意图已不可用')}</p>
     <small>{record.target?`${record.target.host} · ${record.target.project} · ${record.target.title}`:record.targetUnavailable?t('原目标暂不可访问'):t('尚未选择目标会话')}</small>
     {record.resolution&&<><small>{t('完成轮次')} · {record.resolution.nativeTurnId}</small>{record.resolution.result&&<details><summary>{t('续办完成结果')}</summary><p>{record.resolution.result}</p></details>}{record.resolution.historyLimited&&<small>{t('部分任务历史不可用')}</small>}<small>{t('以下为原派发任务记录，保留原执行结果')}</small></>}
     {record.job&&<small>{record.job.jobId}</small>}{record.job?.statusFreshness==='last_known'&&!finished&&<small>{t('主机状态未确认，显示最后已知任务状态')}</small>}
     {record.job?.result&&<details><summary>{t('任务结果')}</summary><p>{record.job.result}</p></details>}
     {record.job?.error&&<p>{record.job.error.code} · {record.job.error.message}</p>}
     {record.job?.historyLimited&&<small>{t('部分任务历史不可用')}</small>}
     {finished&&!record.resolution&&<small>{record.job?.acknowledgedAt?t('已确认知悉'):record.job?.deliveredToVoice?t('已送到语音，尚未确认知悉'):t('结果尚未确认知悉')}</small>}
     {record.target&&<button className="button button--secondary" onClick={()=>onOpenSession(record.target!.sessionId)}>{t('打开目标会话')}</button>}
     {record.state==='pending'&&<button className="button button--secondary" disabled={busy!==null} onClick={()=>void act(record,'cancel')}>{t('取消待办')}</button>}
     {finished&&!record.resolution&&!record.job?.acknowledgedAt&&!record.targetUnavailable&&<button className="button button--secondary" disabled={busy!==null} onClick={()=>void act(record,'ack')}>{t('标记已知悉')}</button>}
    </article>;
   })}</div>
   <div className="voice-task-inbox__pages"><button className="button button--secondary" disabled={!trail.length} onClick={()=>{setCursor(trail.at(-1));setTrail(value=>value.slice(0,-1));}}>{t('上一页')}</button><span>{page?.total??0} {t('条记录')}</span><button className="button button--secondary" disabled={!page?.nextCursor} onClick={()=>{setTrail(value=>[...value,cursor]);setCursor(page?.nextCursor??undefined);}}>{t('下一页')}</button></div>
  </>}
 </section>;
}
