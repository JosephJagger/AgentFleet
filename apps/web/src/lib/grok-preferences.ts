import {useEffect,useRef,useState} from "react";
import {api} from "./api";
export interface GrokSettings {model?:string;contextWindow?:number;xSearch?:{fromDate?:string;toDate?:string}|null;rules?:string;systemPromptOverride?:string;agentProfile?:string;effort?:string;permissionMode?:"default"|"always"|"auto";mode?:"default"|"plan";}
export interface GrokConfigOption {id:string;name?:string;current?:string;values:string[];}
export interface GrokModel {id:string;name:string;efforts:string[];contextWindows?:number[];}
export interface GrokPreferences {observed?:{mode?:string;permissionRequested?:string;permissionStatus?:string;observedAt:string};grokControls?:{planMode:boolean;permissionSync:boolean};nativeManagement?:boolean;canConfigureStartup?:boolean;xSearchSupported?:boolean;commands?:{name:string;description:string;hint?:string}[];models?:GrokModel[];settings:GrokSettings|null;revision:number;options:GrokConfigOption[];}
const empty:GrokPreferences={settings:null,revision:0,options:[]};
export function grokSettingsActive(settings?:GrokSettings|null){
  return Boolean(settings&&Object.keys(settings).length);
}
export function useGrokPreferences(sessionId:string|undefined,sessionSeq?:number){
  const [state,setState]=useState<{id:string|undefined;data:GrokPreferences;ready:boolean;error:string}>({id:undefined,data:empty,ready:false,error:""});
  const [retry,setRetry]=useState(0);
  const active=useRef(sessionId);active.current=sessionId;
  const revision=useRef(0);const readyRef=useRef(false);const chain=useRef(Promise.resolve());const generation=useRef(0);
  const sequence=useRef(sessionSeq);sequence.current=sessionSeq;
  const fetchNow=useRef<(()=>void)|undefined>(undefined);
  const observedSeq=useRef<{id?:string;seq?:number}>({});
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
    fetchNow.current=fetch;
    const timer=window.setTimeout(fetch,0);
    const poll=window.setInterval(()=>{if(sequence.current!==lastSequence||!readyRef.current||Date.now()-lastRead>=30000)fetch();},5000);
    return()=>{fetchNow.current=undefined;controller.abort();window.clearTimeout(timer);window.clearInterval(poll);};
  },[sessionId,retry]);
  useEffect(()=>{
    if(!sessionId){observedSeq.current={};return;}
    if(observedSeq.current.id!==sessionId){observedSeq.current={id:sessionId,seq:sessionSeq};return;}
    if(observedSeq.current.seq===sessionSeq)return;
    observedSeq.current.seq=sessionSeq;
    fetchNow.current?.();
  },[sessionId,sessionSeq]);
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
  return {observed:current?.data.observed,grokControls:current?.data.grokControls,xSearchSupported:current?.data.xSearchSupported===true,canConfigureStartup:current?.data.canConfigureStartup===true,nativeManagement:current?.data.nativeManagement===true,commands:current?.data.commands??[],settings:current?.data.settings??{},options:current?.data.options??[],models:current?.data.models??[],ready:current?.ready===true,error:current?.error??"",save,reload:()=>setRetry(n=>n+1)};
}
