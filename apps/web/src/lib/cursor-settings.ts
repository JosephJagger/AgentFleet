/** Bounded, provider-specific Cursor ACP settings. Values are native opaque identifiers. */
export interface CursorOption {id:string;name:string;category?:string;current?:string;values:Array<{value:string;name:string}>;}
export interface CursorModel {value:string;name:string;configOptions:CursorOption[];}
export interface CursorSettings {options?:Record<string,string>;permissionMode?:"default"|"always";}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v);
export function parseCursorSettings(v:unknown):CursorSettings|undefined {
  if(!record(v)||Object.keys(v).some(k=>!["options","permissionMode"].includes(k)))return;
  if(v.permissionMode!==undefined&&v.permissionMode!=="default"&&v.permissionMode!=="always")return;
  const result:CursorSettings={};
  if(v.options!==undefined){
    if(!record(v.options)||Object.keys(v.options).length>32)return;
    const options:Record<string,string>=Object.create(null);
    for(const [key,value] of Object.entries(v.options)){if(!text(key)||!text(value)||["__proto__","constructor","prototype"].includes(key))return;options[key]=value;}
    result.options=options;
  }
  if(v.permissionMode!==undefined)result.permissionMode=v.permissionMode;
  return result;
}
export function parseCursorOptions(v:unknown):CursorOption[]{
  if(!Array.isArray(v))return [];
  const result:CursorOption[]=[];
  for(const raw of v.slice(0,32)){
    if(!record(raw)||!text(raw.id)||result.some(o=>o.id===raw.id))continue;
    const choices:Array<{value:string;name:string}>=[];
    const add=(list:unknown,depth=0)=>{if(!Array.isArray(list)||depth>1)return;for(const c of list.slice(0,128)){
      if(record(c)&&Array.isArray(c.options)){add(c.options,depth+1);continue;}
      const value=record(c)?c.value:c;
      if(text(value)&&!choices.some(o=>o.value===value))choices.push({value,name:record(c)&&text(c.name)?c.name:value});
    }};
    add(raw.options??raw.values);
    if(!choices.length)continue;
    const current=raw.currentValue??raw.current;
    result.push({id:raw.id,name:text(raw.name)?raw.name:raw.id,...(text(raw.category)?{category:raw.category}:{}),...(text(current)?{current}:{}),values:choices.slice(0,128)});
  }
  return result;
}
export function parseCursorModels(v:unknown):CursorModel[]{
  if(!Array.isArray(v))return [];
  const result:CursorModel[]=[];
  for(const raw of v.slice(0,128))if(record(raw)&&text(raw.value)&&!result.some(m=>m.value===raw.value))result.push({value:raw.value,name:text(raw.name)?raw.name:raw.value,configOptions:parseCursorOptions(raw.configOptions)});
  return result;
}
export function supportsCursorSettings(version:string){const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);return !!m&&(Number(m[1])>0||Number(m[2])>30||Number(m[2])===30&&Number(m[3])>=127);}
