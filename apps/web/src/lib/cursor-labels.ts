import {t} from '../i18n';
import type {CursorOption,CursorModel,CursorSettings} from './cursor-settings';

// Translate only known controls. Native identifiers and model names stay intact.
function kind(option:CursorOption){return option.id.toLowerCase();}
export function cursorOptionLabel(option:CursorOption):string {
  const labels:Record<string,string>={model:'模型',mode:'任务模式',effort:'思考强度',reasoning_effort:'思考强度',fast:'快速模式'};
  return labels[kind(option)]?t(labels[kind(option)]):option.name;
}
export function cursorValueLabel(option:CursorOption,value:string):string {
  return option.values.find(v=>v.value===value)?.name??value;
}

export function cursorSettingsSummary(settings:CursorSettings,options:CursorOption[],models:CursorModel[]):string {
  const modelOption=options.find(o=>o.id==='model');
  const model=settings.options?.model??modelOption?.current;
  const selected=models.find(m=>m.value===model);
  const parts=[selected?.name??(modelOption&&model?cursorValueLabel(modelOption,model):model)??t('沿用原生')];
  // A saved model can differ from the currently observed native model.
  const controls=model&&model!==modelOption?.current?selected?.configOptions??[]:options;
  for(const option of controls){
    if(!['effort','reasoning_effort','fast'].includes(kind(option)))continue;
    const value=settings.options?.[option.id]??option.current;
    if(value)parts.push(cursorValueLabel(option,value));
  }
  parts.push(t(settings.permissionMode==='always'?'始终允许':'逐项确认'));
  return parts.join(' · ');
}
