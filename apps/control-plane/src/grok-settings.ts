export interface GrokSettings {
  model?: string;
  contextWindow?: number;
  xSearch?:{fromDate?:string;toDate?:string}|null;
  rules?:string;
  systemPromptOverride?:string;
  agentProfile?:string;
  effort?: string;
  permissionMode?: "default" | "always" | "auto";
  mode?: "default" | "plan";
}
export interface ConfigOption {id:string;name?:string;current?:string;values:string[];}
const idText=(value:string)=>/^[A-Za-z0-9._:-]{1,120}$/.test(value);
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);

/** Undefined input stays absent. An invalid object stays undefined so the caller can reject it. */
export function parseGrokSettings(value:unknown):GrokSettings|undefined {
  if(value===undefined)return undefined;
  if(!isRecord(value))return undefined;
  if(Object.keys(value).some(key=>!["model","effort","permissionMode","mode","contextWindow","rules","systemPromptOverride","agentProfile","xSearch"].includes(key)))return undefined;
  const settings:GrokSettings={};
  for(const key of ['rules','systemPromptOverride','agentProfile'] as const){const text=value[key];if(text!==undefined){if(typeof text!=='string'||!text.trim()||text.length>(key==='agentProfile'?120:8000)||text.includes('\0')||key==='agentProfile'&&!idText(text))return undefined;settings[key]=text;}}
  if(settings.rules&&settings.systemPromptOverride)return undefined;
  if(value.xSearch===null)settings.xSearch=null;
  else if(value.xSearch!==undefined){
    const x=value.xSearch;if(!isRecord(x)||Object.keys(x).some(k=>!['fromDate','toDate'].includes(k)))return undefined;
    const bounds:{fromDate?:string;toDate?:string}={};
    for(const key of ['fromDate','toDate'] as const){const d=x[key];if(d!==undefined){if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||d.startsWith('0000')||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)return undefined;bounds[key]=d;}}
    if(bounds.fromDate&&bounds.toDate&&bounds.fromDate>bounds.toDate)return undefined;
    if(!bounds.fromDate&&!bounds.toDate)return undefined;settings.xSearch=bounds;
  }
  if(value.contextWindow!==undefined){if(!Number.isSafeInteger(value.contextWindow)||Number(value.contextWindow)<1||Number(value.contextWindow)>10_000_000)return undefined;settings.contextWindow=Number(value.contextWindow);}

  if(value.model!==undefined){if(typeof value.model!=="string"||!idText(value.model))return undefined;settings.model=value.model;}
  if(value.effort!==undefined){if(typeof value.effort!=="string"||!idText(value.effort))return undefined;settings.effort=value.effort;}
  if(value.permissionMode!==undefined){if(value.permissionMode!=="default"&&value.permissionMode!=="always"&&value.permissionMode!=="auto")return undefined;settings.permissionMode=value.permissionMode;}
  if(value.mode!==undefined){if(value.mode!=="default"&&value.mode!=="plan")return undefined;settings.mode=value.mode;}
  return settings;
}
export function grokSettingsActive(settings?:GrokSettings|null):boolean {
  return Boolean(settings&&(settings.xSearch!==undefined||settings.rules||settings.systemPromptOverride||settings.agentProfile||settings.model||settings.effort||settings.contextWindow||(settings.permissionMode&&settings.permissionMode!=="default")||settings.mode==="plan"));
}
export function supportsGrokControls(version?:string):boolean {
  const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version??"");
  if(!match)return false;
  const [major,minor,patch]=match.slice(1).map(Number);
  return major!>0||minor!>30||(minor===30&&patch!>=117);
}
function optionValue(value:unknown):string|undefined {
  if(typeof value==="string"&&idText(value))return value;
  if(isRecord(value)&&typeof value.value==="string"&&idText(value.value))return value.value;
  if(isRecord(value)&&typeof value.id==="string"&&idText(value.id))return value.id;
  return undefined;
}
export function parseConfigOptions(value:unknown):ConfigOption[] {
  if(!Array.isArray(value))return [];
  const options:ConfigOption[]=[];
  for(const entry of value.slice(0,32)){
    if(!isRecord(entry)||typeof entry.id!=="string"||!idText(entry.id))continue;
    const values:string[]=[];
    const raw=Array.isArray(entry.options)?entry.options:Array.isArray(entry.values)?entry.values:[];
    for(const choice of raw.slice(0,64)){const text=optionValue(choice);if(text&&!values.includes(text))values.push(text);}
    const current=optionValue(entry.currentValue??entry.value??entry.current);
    options.push({id:entry.id,...(typeof entry.name==="string"?{name:entry.name.slice(0,120)}:{}),...(current?{current}:{}),values});
  }
  return options;
}
export function mergeConfigOptions(previous:ConfigOption[],next:ConfigOption[]):ConfigOption[] {
  const map=new Map(previous.map(option=>[option.id,option]));
  for(const option of next)map.set(option.id,option);
  return [...map.values()].slice(0,32);
}

export interface GrokModel {id:string;name:string;efforts:string[];contextWindows?:number[];}
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
    const rawWindows=meta.contextWindows??entry.contextWindows;
    const contextWindows=Array.isArray(rawWindows)?[...new Set(rawWindows)].filter((n):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n<=10_000_000).slice(0,16):[];
    models.push({id,...(contextWindows.length?{contextWindows}:{}),name:typeof entry.name==='string'?entry.name.slice(0,120):id,efforts});
  }
  return models;
}
export function grokModelOptions(models:GrokModel[],current?:string):ConfigOption[] {
  if(!models.length)return [];
  return [{id:'model',values:models.map(m=>m.id),...(current?{current}:{})},
    {id:'reasoning_effort',values:models.find(m=>m.id===current)?.efforts??[...new Set(models.flatMap(m=>m.efforts))]}];
}
