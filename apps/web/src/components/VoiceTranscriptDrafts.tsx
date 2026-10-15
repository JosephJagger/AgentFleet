import {ChevronDown,FilePenLine,RefreshCw} from 'lucide-react';
import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {t} from '../i18n';
export interface VoiceTranscriptDraft {id:string;text:string;complete:boolean;revision:number;receipt:{jobId?:string;commandId?:string;todoId?:string}|null;updatedAt:string;}
export function VoiceTranscriptDrafts(){
 const [open,setOpen]=useState(false),[items,setItems]=useState<VoiceTranscriptDraft[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{if(!open)return;let alive=true;void api.voiceTranscriptTails().then(result=>{if(alive){setItems(result.items);setError('');}}).catch(()=>{if(alive)setError(t('待确认转写读取失败'));});return()=>{alive=false;};},[open,revision]);
 async function resolve(item:VoiceTranscriptDraft,action:'save'|'discard'){
  if(busy)return;setBusy(true);try{await api.resolveVoiceTranscriptTail(item.id,{revision:item.revision,action,confirmed:true,text:item.text});setRevision(v=>v+1);}catch{setError(t('转写已变化或已有任务回执，请刷新并查询原任务'));}finally{setBusy(false);}
 }
 return <section className="voice-transcript-drafts"><button type="button" className="voice-record-toggle" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><FilePenLine size={16}/>{t('待确认转写')}<ChevronDown size={14}/></button>{open&&<>
  <p className="voice-record-note">{t('找回通话中断或结束前的最后一句，按需核对。')}</p>
  <details className="voice-record-help"><summary>{t('用途与保留规则')}</summary><p>{t('仅保存已收到的最后一段文字，可能不完整或已经处理；不是执行授权。保留 7 天，确认保存仅创建待办，执行仍需另行明确下达。')}</p></details>
  <button type="button" className="button button--secondary" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={13} aria-hidden="true"/>{t('刷新转写')}</button>
  {error&&<p role="alert">{error}</p>}{!items.length&&!error&&<p className="voice-record-empty">{t('暂无待确认转写')}</p>}
  {items.map(item=><article key={item.id} className="panel-voice-control__task"><strong>{t(item.complete?'待核对的末尾转写':'转写未结束，请补全核对')}</strong>
   <textarea aria-label={t('核对转写内容')} value={item.text} maxLength={8000} onChange={event=>setItems(values=>values.map(value=>value.id===item.id?{...value,text:event.target.value}:value))}/>
   {item.receipt&&<p>{t('已有回执，请先在待办与结果记录中查询，避免重复执行')} · {item.receipt.jobId??item.receipt.commandId??item.receipt.todoId}</p>}
   <div className="voice-record-actions"><button type="button" className="button button--secondary" disabled={busy||!!item.receipt||!item.text.trim()} onClick={()=>void resolve(item,'save')}>{t('确认并保存待办')}</button>
   <button type="button" className="button button--secondary" disabled={busy} onClick={()=>void resolve(item,'discard')}>{t('丢弃转写')}</button></div>
  </article>)}
 </>}</section>;
}
