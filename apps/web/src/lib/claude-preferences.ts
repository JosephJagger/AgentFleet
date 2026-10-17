import {useEffect,useRef,useState} from "react";
import {api} from "./api";
export interface ClaudeSettings {model:string;effort?:string;permissionMode?:"default"|"auto"|"acceptEdits"|"dontAsk";mode?:"default"|"plan";}
export interface ClaudePreferences {settings:ClaudeSettings|null;revision:number;}
const defaults:ClaudeSettings={model:"host",mode:"default"};
export function useClaudePreferences(sessionId:string|undefined){
  const [state,setState]=useState<{id:string|undefined;data:ClaudePreferences;ready:boolean;error:string}>({id:undefined,data:{settings:null,revision:0},ready:false,error:""});
  const [retry,setRetry]=useState(0);
  const active=useRef(sessionId);active.current=sessionId;
  const revision=useRef(0);const readyRef=useRef(false);const chain=useRef(Promise.resolve());
  useEffect(()=>{
    if(!sessionId)return;
    const controller=new AbortController();revision.current=0;readyRef.current=false;chain.current=Promise.resolve();setState({id:sessionId,data:{settings:null,revision:0},ready:false,error:""});
    api.claudePreferences(sessionId,controller.signal).then(data=>{if(controller.signal.aborted||active.current!==sessionId)return;revision.current=data.revision;readyRef.current=true;setState({id:sessionId,data,ready:true,error:""});}).catch(()=>{if(!controller.signal.aborted&&active.current===sessionId){readyRef.current=false;setState({id:sessionId,data:{settings:null,revision:0},ready:false,error:"会话配置读取失败，请重试。"});}});
    return()=>controller.abort();
  },[sessionId,retry]);
  const current=state.id===sessionId?state:undefined;
  async function save(settings:ClaudeSettings){
    if(!sessionId)throw new Error("会话配置尚未读取，请重试。");
    const run=chain.current.then(async()=>{
      if(active.current!==sessionId||!readyRef.current)throw new Error("会话配置尚未读取，请重试。");
      const result=await api.saveClaudePreferences(sessionId,{settings,revision:revision.current});
      revision.current=result.revision;readyRef.current=true;
      if(active.current===sessionId)setState({id:sessionId,data:result,ready:true,error:""});
      return result;
    });
    chain.current=run.then(()=>undefined,()=>undefined);
    await run;
  }
  return {settings:current?.data.settings ?? defaults,ready:current?.ready===true,error:current?.error??"",save,reload:()=>setRetry(n=>n+1)};
}
