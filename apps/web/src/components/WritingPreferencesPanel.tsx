import { t } from "../i18n";
import { useCompletionPreferences, type CompletionPreferences } from "../lib/completion-preferences";
const choices: {key:keyof CompletionPreferences;label:string;description:string}[]=[
  {key:'terms',label:'术语补全',description:'补全编程、Agent、办公、工程、游戏与视频的中英文术语。'},
  {key:'suggestions',label:'提示语与表达建议',description:'补充任务描述，或将口语改为专业表达；采用后仍可编辑。'},
  {key:'nlp',label:'本地 NLP 建议',description:'输入停顿后匹配意思相近的中英文表达，无需配置外部 AI。'},
  {key:'learning',label:'自动积累词库与表达',description:'从已同步的问答中自动提取术语和表达，通过过滤后直接用于输入建议，无需逐条确认。'},
];
export function WritingPreferencesFields({settings,session=false}:{settings:ReturnType<typeof useCompletionPreferences>;session?:boolean}) {
  const [value,update,meta]=settings;
  return <>
    <p>{session ? meta.overrides ? t('已修改的选项仅用于当前会话，其余继承全局设置。') : t('当前继承全局设置；修改任一选项即可单独覆盖。') : t('保存到当前账号，所有会话默认继承，可在会话配置中单独修改。')}</p>
    {meta.loading && <p role="status">{t('读取中')}</p>}
    {meta.error && <p role="alert">{t('输入辅助设置暂不可用，请重试')} <button type="button" onClick={()=>void meta.refresh()}>{t('重试')}</button></p>}
    {choices.map(choice=><label key={choice.key}><input type="checkbox" checked={value[choice.key]} disabled={meta.loading || meta.busy || meta.error} onChange={event=>void update({[choice.key]:event.target.checked})}/><span>{t(choice.label)}{session && meta.overrides?.[choice.key]!==undefined && <small>{t('会话覆盖')}</small>}<small>{t(choice.description)}</small></span></label>)}
    {session && meta.overrides && <button type="button" className="button button--quiet" disabled={meta.busy} onClick={()=>void update(null)}>{t('恢复继承全局设置')}</button>}
  </>;
}
export function WritingPreferencesPanel({owner}:{owner:string}) {
  const settings=useCompletionPreferences(owner);
  return <section className="settings-block completion-settings"><h2>{t('输入辅助')}</h2><WritingPreferencesFields settings={settings}/></section>;
}
