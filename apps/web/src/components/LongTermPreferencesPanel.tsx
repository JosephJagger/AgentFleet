import {useEffect,useState} from 'react';
import {Brain,Plus,Pencil,Trash2} from 'lucide-react';
import {api,type LongTermPreference,type LongTermPreferenceList} from '../lib/api';
import {t} from '../i18n';
export function LongTermPreferencesPanel(){
 const [data,setData]=useState<LongTermPreferenceList>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [editing,setEditing]=useState<LongTermPreference|null|undefined>(),[body,setBody]=useState(''),[conditions,setConditions]=useState(''),[expires,setExpires]=useState(''),[key,setKey]=useState(''),[deleting,setDeleting]=useState<string>();
 const [page,setPage]=useState(0);
 useEffect(()=>{const c=new AbortController();api.longTermPreferences(c.signal).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
 const edit=(item:LongTermPreference|null)=>{setEditing(item);setBody(item?.body??'');setConditions(item?.conditions??'');setExpires(item?.expiresAt?.slice(0,10)??'');setKey(crypto.randomUUID());setError('');};
 async function run(action:()=>Promise<LongTermPreferenceList>){
  if(busy)return;setBusy(true);setError('');try{setData(await action());setEditing(undefined);setDeleting(undefined);setNotice(t('已保存。通话内约 15 秒同步；修改或删除后需重连以清除旧上下文。'));}catch(e){setError(e instanceof Error?e.message:t('操作未完成'));}finally{setBusy(false);}
 }
 const items=data?.items??[],pages=Math.max(1,Math.ceil(items.length/5)),current=Math.min(page,pages-1);
 return <section className="settings-block long-term-preferences">
  <header><div><h2><Brain size={20}/>{t('长期偏好')}</h2><p className="subtle">{t('只属于你的语音规则，在总控和会话通话中跨主机恢复。')}</p></div><button type="button" className="button button--primary" onClick={()=>edit(null)} disabled={busy||!data}><Plus size={16}/>{t('添加偏好')}</button></header>
  <p className="subtle">{t('与开发待办分开，不自动从历史学习，不影响文字开发任务。')}</p>
  {data&&<p className="subtle">{data.bytes} / {data.budget} bytes · {t('完整加载预算，超限提示整理，不自动压缩')}</p>}
  {error&&<p role="alert">{error} <button type="button" className="button button--secondary" onClick={()=>void api.longTermPreferences().then(setData).catch(e=>setError(e.message))}>{t('重新读取')}</button></p>}
  {notice&&<p role="status">{notice}</p>}
  {!data&&!error&&<p>{t('正在读取配置')}</p>}
  {data&&!items.length&&<p>{t('暂无长期偏好。添加明确的行为规则后，下次通话会自动加载。')}</p>}
  {editing!==undefined&&<form className="long-term-preferences__editor" onSubmit={e=>{e.preventDefault();void run(()=>api.saveLongTermPreference({body,conditions,expiresAt:expires?new Date(expires+'T23:59:59Z').toISOString():null,...(editing?{revision:editing.revision}:{key})},editing?.id));}}>
    <label>{t('偏好规则')}<textarea required rows={4} value={body} onChange={e=>setBody(e.target.value)}/></label>
    <label>{t('适用条件')}<textarea rows={2} placeholder={t('例如：当我用英语表达时')} value={conditions} onChange={e=>setConditions(e.target.value)}/></label>
    <label>{t('有效期（留空表示长期有效，UTC）')}<input type="date" value={expires} onChange={e=>setExpires(e.target.value)}/></label>
    <div className="long-term-preferences__actions"><button className="button button--primary" disabled={busy}>{t('保存偏好')}</button><button type="button" className="button button--secondary" disabled={busy} onClick={()=>setEditing(undefined)}>{t('取消')}</button></div>
  </form>}
  <div>{items.slice(current*5,current*5+5).map(item=><article key={item.id} className="long-term-preferences__entry">
    <p>{item.body}</p>{item.conditions&&<p className="subtle">{t('适用条件')}：{item.conditions}</p>}
    <small>{t(!item.enabled?'已停用':item.expiresAt&&Date.parse(item.expiresAt)<=Date.now()?'已过期':'已启用')}{item.expiresAt?' · '+new Date(item.expiresAt).toLocaleDateString():''}</small>
    <div className="long-term-preferences__actions"><button type="button" className="button button--secondary" disabled={busy} onClick={()=>edit(item)}><Pencil size={15}/>{t('编辑')}</button><button type="button" className="button button--secondary" disabled={busy} onClick={()=>void run(()=>api.saveLongTermPreference({revision:item.revision,enabled:!item.enabled},item.id))}>{t(item.enabled?'停用':'启用')}</button><button type="button" className="button button--secondary" disabled={busy} onClick={()=>setDeleting(item.id)}><Trash2 size={15}/>{t('删除')}</button></div>
    {deleting===item.id&&<div role="alert"><p>{t('删除后不会从旧历史自动恢复。当前通话需重连以清除旧上下文。')}</p><button type="button" className="button button--primary" disabled={busy} onClick={()=>void run(()=>api.deleteLongTermPreference(item.id,item.revision))}>{t('确认删除')}</button><button type="button" className="button button--secondary" onClick={()=>setDeleting(undefined)}>{t('取消')}</button></div>}
  </article>)}</div>
  {pages>1&&<nav className="long-term-preferences__actions" aria-label={t('偏好分页')}><button className="button button--secondary" disabled={!current} onClick={()=>setPage(current-1)}>{t('上一页')}</button><span>{current+1} / {pages}</span><button className="button button--secondary" disabled={current===pages-1} onClick={()=>setPage(current+1)}>{t('下一页')}</button></nav>}
 </section>;
}
