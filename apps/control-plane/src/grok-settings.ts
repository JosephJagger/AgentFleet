export interface GrokSettings {
  model?: string;
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
  if(Object.keys(value).some(key=>!["model","effort","permissionMode","mode"].includes(key)))return undefined;
  const settings:GrokSettings={};
  if(value.model!==undefined){if(typeof value.model!=="string"||!idText(value.model))return undefined;settings.model=value.model;}
  if(value.effort!==undefined){if(typeof value.effort!=="string"||!idText(value.effort))return undefined;settings.effort=value.effort;}
  if(value.permissionMode!==undefined){if(value.permissionMode!=="default"&&value.permissionMode!=="always"&&value.permissionMode!=="auto")return undefined;settings.permissionMode=value.permissionMode;}
  if(value.mode!==undefined){if(value.mode!=="default"&&value.mode!=="plan")return undefined;settings.mode=value.mode;}
  return settings;
}
export function grokSettingsActive(settings?:GrokSettings|null):boolean {
  return Boolean(settings&&(settings.model||settings.effort||(settings.permissionMode&&settings.permissionMode!=="default")||settings.mode==="plan"));
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
