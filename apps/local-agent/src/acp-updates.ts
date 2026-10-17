import {isRecord} from './util.js';

export interface GrokSettings {
  model?: string;
  effort?: string;
  permissionMode?: 'default' | 'always' | 'auto';
  mode?: 'default' | 'plan';
}
export interface ConfigOption {id:string;name?:string;current?:string;values:string[];}
const idText=(value:string)=>/^[A-Za-z0-9._:-]{1,120}$/.test(value);
const keys=['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens','totalTokens'] as const;
type TokenCounts=Record<(typeof keys)[number],number>;

/** Undefined input stays absent. An invalid object stays undefined so the caller can reject it. */
export function parseGrokSettings(value:unknown):GrokSettings|undefined {
  if(value===undefined)return undefined;
  if(!isRecord(value))return undefined;
  if(Object.keys(value).some(key=>!['model','effort','permissionMode','mode'].includes(key)))return undefined;
  const settings:GrokSettings={};
  if(value.model!==undefined){if(typeof value.model!=='string'||!idText(value.model))return undefined;settings.model=value.model;}
  if(value.effort!==undefined){if(typeof value.effort!=='string'||!idText(value.effort))return undefined;settings.effort=value.effort;}
  if(value.permissionMode!==undefined){if(value.permissionMode!=='default'&&value.permissionMode!=='always'&&value.permissionMode!=='auto')return undefined;settings.permissionMode=value.permissionMode;}
  if(value.mode!==undefined){if(value.mode!=='default'&&value.mode!=='plan')return undefined;settings.mode=value.mode;}
  return settings;
}
export function grokSettingsActive(settings?:GrokSettings):boolean {
  return Boolean(settings&&(settings.model||settings.effort||(settings.permissionMode&&settings.permissionMode!=='default')||settings.mode==='plan'));
}
/** Flags belong after `agent` and before `stdio`. Only documented model and always-approve flags are added. */
export function grokLaunchArgs(base:string[],settings?:GrokSettings):string[] {
  if(!settings?.model&&settings?.permissionMode!=='always')return [...base];
  const args=[...base];
  const stdio=args.at(-1)==='stdio'?args.pop():undefined;
  if(settings.model)args.push('--model',settings.model);
  if(settings.permissionMode==='always')args.push('--always-approve');
  if(stdio)args.push(stdio);
  return args;
}
/** `_meta` is documented on session/new, not on session/load. */
export function grokSessionMeta(settings?:GrokSettings):Record<string,boolean>|undefined {
  if(settings?.permissionMode==='always')return {yoloMode:true};
  if(settings?.permissionMode==='auto')return {autoMode:true};
  return undefined;
}
function optionValue(value:unknown):string|undefined {
  if(typeof value==='string'&&idText(value))return value;
  if(isRecord(value)&&typeof value.value==='string'&&idText(value.value))return value.value;
  if(isRecord(value)&&typeof value.id==='string'&&idText(value.id))return value.id;
  return undefined;
}
export function parseConfigOptions(value:unknown):ConfigOption[] {
  if(!Array.isArray(value))return [];
  const options:ConfigOption[]=[];
  for(const entry of value.slice(0,32)){
    if(!isRecord(entry)||typeof entry.id!=='string'||!idText(entry.id))continue;
    const values:string[]=[];
    const raw=Array.isArray(entry.options)?entry.options:Array.isArray(entry.values)?entry.values:[];
    for(const choice of raw.slice(0,64)){const text=optionValue(choice);if(text&&!values.includes(text))values.push(text);}
    const current=optionValue(entry.currentValue??entry.value??entry.current);
    options.push({id:entry.id,...(typeof entry.name==='string'?{name:entry.name.slice(0,120)}:{}),...(current?{current}:{}),values});
  }
  return options;
}
export function mergeConfigOptions(previous:ConfigOption[],next:ConfigOption[]):ConfigOption[] {
  const map=new Map(previous.map(option=>[option.id,option]));
  for(const option of next)map.set(option.id,option);
  return [...map.values()].slice(0,32);
}
export function acpText(value:unknown):string {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(acpText).filter(Boolean).join('\n');
  if(!isRecord(value))return '';
  if(typeof value.text==='string')return value.text;
  if(typeof value.diff==='string')return value.diff;
  if(typeof value.stdout==='string')return value.stdout;
  if(typeof value.output==='string')return value.output;
  if(typeof value.content==='string')return value.content;
  if(value.content!==undefined)return acpText(value.content);
  const primitive=Object.values(value).every(item=>item===null||['string','number','boolean'].includes(typeof item));
  return primitive?Object.entries(value).map(([key,item])=>`${key}: ${String(item)}`).join('\n').slice(0,4000):'';
}
export function acpPlanText(update:Record<string,unknown>):string {
  const entries=Array.isArray(update.entries)?update.entries:Array.isArray(update.plan)?update.plan:[];
  const lines=entries.map(entry=>{
    if(typeof entry==='string')return entry;
    if(!isRecord(entry))return '';
    const content=typeof entry.content==='string'?entry.content:typeof entry.title==='string'?entry.title:'';
    const status=typeof entry.status==='string'?entry.status:'';
    return [status,content].filter(Boolean).join(' ');
  }).filter(Boolean);
  return (lines.length?lines.join('\n'):acpText(update.content??update.plan)).slice(0,4000);
}
/** Tool title and result text only. Raw arguments stay off the item. */
export function acpToolItem(update:Record<string,unknown>,previous?:Record<string,unknown>):Record<string,unknown> {
  const rawInput=isRecord(update.rawInput)?update.rawInput:isRecord(update.input)?update.input:undefined;
  const command=(rawInput&&typeof rawInput.command==='string'&&rawInput.command.trim()?rawInput.command:typeof update.title==='string'&&update.title.trim()?update.title:typeof previous?.command==='string'?previous.command:'Tool').slice(0,2000);
  const statusRaw=typeof update.status==='string'?update.status:typeof previous?.status==='string'?previous.status:'inProgress';
  const status=statusRaw==='completed'||statusRaw==='failed'||statusRaw==='declined'?statusRaw:'inProgress';
  const changes=(Array.isArray(update.content)?update.content:[]).flatMap(block=>{
    if(!isRecord(block)||block.type!=='diff'||typeof block.path!=='string')return [];
    const oldText=typeof block.oldText==='string'?block.oldText:'';
    const newText=typeof block.newText==='string'?block.newText:'';
    const diff=typeof block.diff==='string'?block.diff:`--- ${block.path}\n+++ ${block.path}\n${oldText.split('\n').map(line=>'-'+line).join('\n')}\n${newText.split('\n').map(line=>'+'+line).join('\n')}`;
    return [{path:block.path.slice(0,2000),diff:diff.slice(0,64000)}];
  }).slice(0,32);
  if(changes.length||previous?.type==='fileChange')return {type:'fileChange',status,changes:changes.length?changes:previous?.changes};
  const fullOutput=acpText(update.rawOutput??update.content??update.output??previous?.aggregatedOutput);
  const output=fullOutput.slice(0,64000);
  return {type:'commandExecution',command,status,tool:(typeof update.title==='string'?update.title:typeof previous?.tool==='string'?previous.tool:'Tool').slice(0,200),...(output?{aggregatedOutput:output,outputTruncated:fullOutput.length>64000}:{})};
}
function finite(value:unknown):number|undefined {return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):undefined;}
function tokenCounts(value:Record<string,unknown>):TokenCounts|undefined {
  const counts={} as TokenCounts;
  for(const key of keys){const number=finite(value[key]);if(number===undefined)return;counts[key]=number;}
  if(counts.cachedInputTokens>counts.inputTokens||counts.reasoningOutputTokens>counts.outputTokens)return;
  return counts;
}
function flatUsage(source:Record<string,unknown>):TokenCounts|undefined {
  const input=finite(source.inputTokens??source.input_tokens);
  const output=finite(source.outputTokens??source.output_tokens);
  if(input===undefined||output===undefined)return;
  const cached=finite(source.cachedInputTokens??source.cacheReadInputTokens??source.cache_read_input_tokens)??0;
  const reasoning=finite(source.reasoningOutputTokens??source.reasoningTokens??source.reasoning_tokens)??0;
  const camelInput=finite(source.inputTokens);
  const inputTokens=camelInput===undefined&&cached>input?input+cached:input;
  const total=finite(source.totalTokens??source.total_tokens)??inputTokens+output;
  return tokenCounts({inputTokens,outputTokens:output,cachedInputTokens:cached,reasoningOutputTokens:reasoning,totalTokens:total});
}
/** Emit only counts the prompt result actually carried. Missing usage stays absent. */
export function acpUsage(result:Record<string,unknown>):{usage:{total:TokenCounts;last:TokenCounts}}|undefined {
  const meta=isRecord(result._meta)?result._meta.usage:undefined;
  for(const source of [result.usage,meta]){
    if(!isRecord(source))continue;
    if(isRecord(source.total)&&isRecord(source.last)){
      const total=tokenCounts(source.total),last=tokenCounts(source.last);
      if(total&&last&&keys.every(key=>last[key]<=total[key])&&(total.totalTokens>0||last.totalTokens>0))return {usage:{total,last}};
    }
    const flat=flatUsage(source);
    if(flat&&flat.totalTokens>0)return {usage:{total:flat,last:flat}};
  }
  return undefined;
}

export interface GrokModel {id:string;name:string;efforts:string[];}
/** Keep only displayable catalog fields; never forward initialize metadata wholesale. */
export function parseGrokModels(value:unknown):GrokModel[] {
  if(!Array.isArray(value))return [];
  const models:GrokModel[]=[];
  for(const entry of value.slice(0,64)) {
    if(!isRecord(entry))continue;
    const id=optionValue(entry.modelId??entry.id);
    if(!id||models.some(model=>model.id===id))continue;
    const meta=isRecord(entry._meta)?entry._meta:{};
    const raw=Array.isArray(entry.efforts)?entry.efforts:Array.isArray(meta.reasoningEfforts)?meta.reasoningEfforts:[];
    const efforts=meta.supportsReasoningEffort===false?[]:[...new Set(raw.slice(0,32).map(optionValue).filter((v):v is string=>Boolean(v)))];
    models.push({id,name:typeof entry.name==='string'?entry.name.slice(0,120):id,efforts});
  }
  return models;
}
export function grokModelOptions(models:GrokModel[],current?:string):ConfigOption[] {
  if(!models.length)return [];
  return [{id:'model',values:models.map(m=>m.id),...(current?{current}:{})},
    {id:'reasoning_effort',values:models.find(m=>m.id===current)?.efforts??[...new Set(models.flatMap(m=>m.efforts))]}];
}
