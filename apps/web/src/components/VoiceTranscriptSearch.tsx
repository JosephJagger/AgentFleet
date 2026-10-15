import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {t} from '../i18n';
export function VoiceTranscriptSearch(){
 const [settings,setSettings]=useState<{enabled:boolean;revision:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void api.voiceTranscriptSettings().then(value=>{if(alive)setSettings(value);}).catch(()=>{if(alive)setError(t('转写设置读取失败，请重新打开面板'));});return()=>{alive=false;};},[]);
 async function save(enabled:boolean){
  if(!settings||busy)return;setBusy(true);setError('');
  try{setSettings(await api.saveVoiceTranscriptSettings({enabled,revision:settings.revision}));}
  catch{setError(t('保存失败或设置已变化，请重试'));try{setSettings(await api.voiceTranscriptSettings());}catch{setSettings(null);}}
  finally{setBusy(false);}
 }
 return <section className="voice-transcript-search">
  <label className="voice-transcript-search__toggle"><input type="checkbox" checked={settings?.enabled??false} disabled={!settings||busy} onChange={event=>void save(event.target.checked)}/><span>{t('支持搜索转写')}</span></label>
  <p className="voice-record-note">{t('通话转写保存 30 天。勾选后，仅在你提出请求时搜索。')}</p>
  <details className="voice-record-help"><summary>{t('保存与搜索说明')}</summary><p>{t('仅保存本账号在当前工作区已上传的语音总控转写，含你和助手的文字。关闭搜索仍会保存；不会自动读取或执行历史指令。')}</p><p>{t('例如：“看看最近三次通话”“查一下最近一周的转写”，也可指定时间或加关键词。双方转写按通话及发言顺序分页查看。')}</p><p>{t('关键词可不填；关键词和范围都未指定时默认最近一次；含当前通话。仅有最近 30 天已上传文字，未识别、未上传或已过期内容无法恢复。')}</p><p>{t('查询不会保存或执行历史任务。新需求可明确说“请把这条新需求保存为待办”；保存不等于执行。')}</p></details>
  {error&&<p role="alert">{error}</p>}
 </section>;
}
