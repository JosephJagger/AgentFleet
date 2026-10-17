import {useEffect,useRef,useState} from "react";
import {api} from "./api";
export interface GrokSettings {model?:string;effort?:string;permissionMode?:"default"|"always"|"auto";mode?:"default"|"plan";}
export interface GrokConfigOption {id:string;name?:string;current?:string;values:string[];}
export interface GrokPreferences {settings:GrokSettings|null;revision:number;options:GrokConfigOption[];}
const empty:GrokPreferences={settings:null,revision:0,options:[]};
export function grokSettingsActive(settings?:GrokSettings|null){
  return Boolean(settings&&(settings.model||settings.effort||(settings.permissionMode&&settings.permissionMode!=="default")||settings.mode==="plan"));
}
export function useGrokPreferences(sessionId:string|undefined,sessionSeq?:number){
  const [state,setState]=useState<{id:string|undefined;data:GrokPreferences;ready:boolean;error:string}>({id:undefined,data:empty,ready:false,error:""});
  const [retry,setRetry]=useState(0);
  const active=useRef(sessionId);active.current=sessionId;
  const revision=useRef(0);const readyRef=useRef(false);const chain=useRef(Promise.resolve());const seen=useRef<string|undefined>(undefined);
  useEffect(()=>{
    if(!sessionId)return;
    const controller=new AbortController();
    const immediate=seen.current!==sessionId;seen.current=sessionId;
    const timer=window.setTimeout(()=>{
      if(immediate){revision.current=0;readyRef.current=false;chain.current=Promise.resolve();setState({id:sessionId,data:empty,ready:false,error:""});}
      api.grokPreferences(sessionId,controller.signal).then(data=>{
        if(controller.signal.aborted||active.current!==sessionId)return;
        if(data.revision>=revision.current)revision.current=data.revision;
        readyRef.current=true;setState({id:sessionId,data,ready:true,error:""});
      }).catch(()=>{if(!controller.signal.aborted&&active.current===sessionId){readyRef.current=false;setState({id:sessionId,data:empty,ready:false,error:"会话配置读取失败，请重试。"});}});
    },immediate?0:400);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[sessionId,sessionSeq,retry]);
  const current=state.id===sessionId?state:undefined;
  async function save(settings:GrokSettings){
    if(!sessionId)throw new Error("会话配置尚未读取，请重试。");
    const run=chain.current.then(async()=>{
      if(active.current!==sessionId||!readyRef.current)throw new Error("会话配置尚未读取，请重试。");
      const result=await api.saveGrokPreferences(sessionId,{settings,revision:revision.current});
      revision.current=result.revision;readyRef.current=true;
      if(active.current===sessionId)setState({id:sessionId,data:result,ready:true,error:""});
      return result;
    });
    chain.current=run.then(()=>undefined,()=>undefined);
    await run;
  }
  return {settings:current?.data.settings??{},options:current?.data.options??[],ready:current?.ready===true,error:current?.error??"",save,reload:()=>setRetry(n=>n+1)};
}
