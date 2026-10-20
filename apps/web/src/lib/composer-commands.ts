import {t} from '../i18n';
import type {ClaudeSettings} from './claude-preferences';
import type {ClaudeModel} from './types';
import type {GrokSettings,GrokModel,GrokConfigOption} from './grok-preferences';
import type {CursorSettings,CursorOption,CursorModel} from './cursor-settings';
import {cursorOptionLabel,cursorValueLabel} from './cursor-labels';

export interface CommandChoice {value:string;label:string;aliases?:string[];selected?:boolean;confirmation?:string}
export interface ComposerCommand {
  name:string;description:string;hint?:string;choices?:CommandChoice[];unavailable?:string;
  apply?:(value:string)=>Promise<void>;
}
export function parseComposerCommand(prompt:string){
  const match=/^\s*\/([\w:-]*)(?:[ \t]+([^\r\n]*))?$/.exec(prompt);
  return match?{name:match[1].toLowerCase(),args:match[2]?.trim()??'',values:match[2]!==undefined}:undefined;
}
export const commandMatches=(choice:CommandChoice,text:string)=>[choice.value,choice.label,...choice.aliases??[]].some(v=>v.toLowerCase().includes(text.toLowerCase()));
export const exactCommandChoice=(choices:CommandChoice[],text:string)=>{
  const exact=choices.filter(c=>[c.value,...c.aliases??[]].some(v=>v.toLowerCase()===text.toLowerCase()));
  return exact.length===1?exact[0]:undefined;
};
const inherit=(selected:boolean):CommandChoice=>({value:'host',label:t('沿用原生'),selected});
const modes=(current:string):CommandChoice[]=>[{value:'default',label:t('普通执行'),selected:current==='default',aliases:['off']},{value:'plan',label:t('计划模式'),selected:current==='plan',aliases:['on']}];
const permissions=(values:string[],current:string):CommandChoice[]=>values.map(value=>({value,label:t(value==='always'?'始终允许':value==='auto'?'自动审核':value==='acceptEdits'?'自动接受编辑':value==='dontAsk'?'仅已允许工具':'逐项确认'),selected:value===current,...(value!=='default'?{confirmation:t('此设置会改变后续任务的工具审批方式；当前任务保持不变。')}: {})}));
const blocked=(ready:boolean,supported=true)=>!ready?t('会话配置尚未读取，请重试。'):!supported?t('当前主机尚未提供此配置能力'):undefined;
export function claudeComposerCommands(p:{settings:ClaudeSettings;models:ClaudeModel[];permissionModes:string[];ready:boolean;supported:boolean;save:(s:ClaudeSettings)=>Promise<void>}):ComposerCommand[]{
 const {settings,models,save}=p,model=models.find(m=>m.model===settings.model),unavailable=!p.supported?t("Claude Code 原生控制需要 Agent 0.30.57 或更新版本"):blocked(p.ready);
 return [
  {name:'model',description:t('模型'),unavailable,choices:[{...inherit(settings.model==='host'),value:'host'},...models.map(m=>({value:m.model,label:m.displayName,selected:m.model===settings.model,aliases:['sonnet','opus','haiku'].filter(a=>m.model.startsWith(`claude-${a}-`))}))],apply:value=>save({...settings,model:value,effort:undefined,permissionMode:settings.permissionMode==='auto'?'default':settings.permissionMode})},
  {name:'effort',description:t('思考强度'),unavailable,choices:[inherit(!settings.effort),...(model?.efforts??(settings.model==='host'?models[0]?.efforts:[])??[]).map(value=>({value,label:value,selected:settings.effort===value}))],apply:value=>save({...settings,effort:value==='host'?undefined:value})},
  {name:'plan',description:t('计划模式'),unavailable,choices:modes(settings.mode??'default'),apply:value=>save({...settings,mode:value as ClaudeSettings['mode']})},
  {name:'permissions',description:t('会话权限'),unavailable:unavailable||(!p.permissionModes.length?t('权限选择需要宿主机 Agent 更新及原生 Claude 支持。'):undefined),choices:permissions(['default',...p.permissionModes.filter(v=>v!=='default'&&(v!=='auto'||(model??models[0])?.supportsAutoMode===true))],settings.permissionMode??'default'),apply:value=>save({...settings,permissionMode:value as ClaudeSettings['permissionMode']})},
 ];
}
export function grokComposerCommands(p:{settings:GrokSettings;models:GrokModel[];options:GrokConfigOption[];ready:boolean;save:(s:GrokSettings)=>Promise<void>}):ComposerCommand[]{
 const {settings,models,options,save}=p,modelOption=options.find(o=>o.id==='model'),model=models.find(m=>m.id===(settings.model||modelOption?.current)),unavailable=blocked(p.ready);
 return [
  {name:'model',description:t('模型'),unavailable,choices:[inherit(!settings.model),...(modelOption?.values??[]).map(value=>({value,label:models.find(m=>m.id===value)?.name??value,selected:value===settings.model}))],apply:value=>{const id=value==='host'?undefined:value,efforts=models.find(m=>m.id===id)?.efforts;return save({...settings,model:id,contextWindow:undefined,...(efforts&&settings.effort&&!efforts.includes(settings.effort)?{effort:undefined}:{})});}},
  {name:'effort',description:t('思考强度'),unavailable,choices:[inherit(!settings.effort),...(model?.efforts??options.find(o=>o.id==='reasoning_effort')?.values??[]).map(value=>({value,label:value,selected:value===settings.effort}))],apply:value=>save({...settings,effort:value==='host'?undefined:value})},
  {name:'plan',description:t('计划模式'),unavailable,choices:modes(settings.mode??'default'),apply:value=>save({...settings,mode:value as GrokSettings['mode']})},
  {name:'permissions',description:t('会话权限'),unavailable,choices:permissions(['default','always','auto'],settings.permissionMode??'default'),apply:value=>save({...settings,permissionMode:value as GrokSettings['permissionMode']})},
 ];
}
export function cursorCommandOptions(settings:CursorSettings,options:CursorOption[],models:CursorModel[]){
 const current=options.find(o=>o.id==='model')?.current,model=settings.options?.model??current;
 return model&&model!==current?options.filter(o=>o.id==='mode'||o.id==='model').concat(models.find(m=>m.value===model)?.configOptions??[]):options;
}
export function cursorComposerCommands(p:{settings:CursorSettings;options:CursorOption[];models:CursorModel[];ready:boolean;supported:boolean;save:(s:CursorSettings)=>Promise<void>}):ComposerCommand[]{
 const {settings,save}=p,unavailable=blocked(p.ready,p.supported);
 const commands=cursorCommandOptions(settings,p.options,p.models).flatMap(option=>{
  const name=option.id==='model'?'model':option.id==='mode'?'plan':option.id==='reasoning_effort'||option.id==='effort'?'effort':option.id==='fast'?'fast':undefined;
  if(!name)return [];
  return [{name,description:cursorOptionLabel(option),unavailable,choices:[inherit(!settings.options?.[option.id]),...option.values.map(v=>({value:v.value,label:cursorValueLabel(option,v.value),selected:v.value===settings.options?.[option.id]}))],apply:(value:string)=>{const next:Record<string,string>=option.id==='model'?{...(settings.options?.mode?{mode:settings.options.mode}:{})}:{...settings.options};if(value==='host')delete next[option.id];else next[option.id]=value;return save({...settings,options:next});}}];
 });
 const missing=['model','effort','plan','fast'].filter(name=>!commands.some(c=>c.name===name)).map(name=>({name,description:t('当前主机尚未提供此配置能力'),choices:[],unavailable:unavailable??t('当前主机尚未提供此配置能力')}));
 return [...commands,...missing,{name:'permissions',description:t('会话权限'),unavailable,choices:permissions(['default','always'],settings.permissionMode??'default'),apply:value=>save({...settings,permissionMode:value as CursorSettings['permissionMode']})}];
}
