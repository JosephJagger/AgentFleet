import {useEffect,useRef,useState} from "react";
import {api} from "./api";
export interface ClaudeSettings {model:string;effort?:string;permissionMode?:"default"|"auto"|"acceptEdits"|"dontAsk";mode?:"default"|"plan";}
export interface ClaudePreferences {settings:ClaudeSettings|null;revision:number;}
const defaults:ClaudeSettings={model:"host",mode:"default"};
export function useClaudePreferences(sessionId:string|undefined){
  const [state,setState]=useState<{id:string|undefined;data:ClaudePreferences;ready:boolean;error:string}>({id:undefined,data:{settings:null,revision:0},ready:false,error:""});
  const [retry,setRetry]=useState(0);
  const active=useRef(sessionId);active.current=sessionId;
  useEffect(()=>{
    if(!sessionId)return;
    const controller=new AbortController();setState({id:sessionId,data:{settings:null,revision:0},ready:false,error:""});
    api.claudePreferences(sessionId,controller.signal).then(data=>{if(!controller.signal.aborted)setState({id:sessionId,data,ready:true,error:""});}).catch(()=>{if(!controller.signal.aborted)setState({id:sessionId,data:{settings:null,revision:0},ready:false,error:"会话配置读取失败，请重试。"});});
    return()=>controller.abort();
  },[sessionId,retry]);
  const current=state.id===sessionId?state:undefined;
  async function save(settings:ClaudeSettings){
    if(!sessionId || !current?.ready)throw new Error("会话配置尚未读取，请重试。");
    const result=await api.saveClaudePreferences(sessionId,{settings,revision:current.data.revision});
    if(active.current===sessionId)setState({id:sessionId,data:result,ready:true,error:""});
  }
  return {settings:current?.data.settings ?? defaults,ready:current?.ready===true,error:current?.error??"",save,reload:()=>setRetry(n=>n+1)};
}
