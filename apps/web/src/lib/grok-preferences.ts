import {useEffect,useRef,useState} from "react";
import {api} from "./api";
export interface GrokSettings {model?:string;effort?:string;permissionMode?:"default"|"always"|"auto";mode?:"default"|"plan";}
export interface GrokConfigOption {id:string;name?:string;current?:string;values:string[];}
export interface GrokModel {id:string;name:string;efforts:string[];}
export interface GrokPreferences {models?:GrokModel[];settings:GrokSettings|null;revision:number;options:GrokConfigOption[];}
const empty:GrokPreferences={settings:null,revision:0,options:[]};
export function grokSettingsActive(settings?:GrokSettings|null){
  return Boolean(settings&&(settings.model||settings.effort||(settings.permissionMode&&settings.permissionMode!=="default")||settings.mode==="plan"));
}
export function useGrokPreferences(sessionId:string|undefined,sessionSeq?:number){
  const [state,setState]=useState<{id:string|undefined;data:GrokPreferences;ready:boolean;error:string}>({id:undefined,data:empty,ready:false,error:""});
  const [retry,setRetry]=useState(0);
  const active=useRef(sessionId);active.current=sessionId;
  const revision=useRef(0);const readyRef=useRef(false);const chain=useRef(Promise.resolve());const generation=useRef(0);
  const sequence=useRef(sessionSeq);sequence.current=sessionSeq;
  useEffect(()=>{
    if(!sessionId)return;
    const controller=new AbortController();
    revision.current=0;readyRef.current=false;chain.current=Promise.resolve();
    const epoch=++generation.current;
    let pending=false,lastSequence:number|undefined,lastRead=0;
    const fetch=()=>{
      if(pending)return;
      pending=true;lastSequence=sequence.current;lastRead=Date.now();
      api.grokPreferences(sessionId,controller.signal).then(data=>{
        if(controller.signal.aborted||generation.current!==epoch||active.current!==sessionId||data.revision<revision.current)return;
        revision.current=data.revision;readyRef.current=true;
        setState({id:sessionId,data,ready:true,error:""});
      }).catch(()=>{
        if(!controller.signal.aborted&&active.current===sessionId&&!readyRef.current)
          setState({id:sessionId,data:empty,ready:false,error:"会话配置读取失败，请重试。"});
      }).finally(()=>{pending=false;});
    };
    // Token/event traffic must neither abort the initial read nor postpone it forever.
    const timer=window.setTimeout(fetch,0);
    const poll=window.setInterval(()=>{if(sequence.current!==lastSequence||!readyRef.current||Date.now()-lastRead>=30000)fetch();},5000);
    return()=>{controller.abort();window.clearTimeout(timer);window.clearInterval(poll);};
  },[sessionId,retry]);
  const current=state.id===sessionId?state:undefined;
  async function save(settings:GrokSettings){
    if(!sessionId)throw new Error("会话配置尚未读取，请重试。");
    const epoch=generation.current;
    const run=chain.current.then(async()=>{
      if(generation.current!==epoch||active.current!==sessionId||!readyRef.current)throw new Error("会话配置尚未读取，请重试。");
      const result=await api.saveGrokPreferences(sessionId,{settings,revision:revision.current});
      if(generation.current!==epoch||active.current!==sessionId)return result;
      revision.current=result.revision;readyRef.current=true;
      setState({id:sessionId,data:result,ready:true,error:""});
      return result;
    });
    chain.current=run.then(()=>undefined,()=>undefined);
    await run;
  }
  return {settings:current?.data.settings??{},options:current?.data.options??[],models:current?.data.models??[],ready:current?.ready===true,error:current?.error??"",save,reload:()=>setRetry(n=>n+1)};
}
