import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
export type CompletionPreferences = { terms: boolean; suggestions: boolean; nlp: boolean; learning: boolean };
export type WritingPreferencesState = { defaults: CompletionPreferences; overrides: Partial<CompletionPreferences> | null; effective: CompletionPreferences };
const fallback: CompletionPreferences = { terms: true, suggestions: true, nlp: false, learning: false };

export function useCompletionPreferences(owner: string, sessionId?: string) {
  const key=JSON.stringify([owner,sessionId]);
  const scope=useRef(key);scope.current=key;
  const saving=useRef(false);
  const revision=useRef(0);
  const [state,setState]=useState<{key:string;data?:WritingPreferencesState;error?:boolean;busy?:boolean}>();
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    if(saving.current) return;
    const stamp=revision.current;
    try {
      let data=await api.writingPreferences(sessionId,signal);
      if(signal?.aborted || stamp!==revision.current) return;
      // Import old browser-only session choices once; new choices live with the account.
      if(sessionId && data.overrides===null) {
        const legacyKey=`agentfleet.completions:${encodeURIComponent(owner)}:${encodeURIComponent(sessionId)}`;
        let legacy: unknown;try{legacy=JSON.parse(localStorage.getItem(legacyKey)??'null');}catch{legacy=null;}
        if(legacy && typeof legacy==='object') {
          const settings:Partial<CompletionPreferences>={};
          for(const name of ['terms','suggestions','nlp'] as const) if(typeof (legacy as CompletionPreferences)[name]==='boolean') settings[name]=(legacy as CompletionPreferences)[name];
          if(Object.keys(settings).length) data=await api.saveWritingPreferences(settings,sessionId,signal);
          if(signal?.aborted || stamp!==revision.current) return;
          try{localStorage.removeItem(legacyKey);}catch{/* Ignore unavailable storage. */}
        }
      }
      setState({key,data});
    } catch { if(!signal?.aborted && stamp===revision.current) setState(previous=>({key,...(previous?.key===key && previous.data ? {data:previous.data}:{}),error:true})); }
  },[key,owner,sessionId]);
  useEffect(()=>{
    let controller=new AbortController();
    const load=()=>{controller.abort();controller=new AbortController();void refresh(controller.signal);};
    load();window.addEventListener('focus',load);window.addEventListener('writing-preferences-changed',load);
    return()=>{controller.abort();window.removeEventListener('focus',load);window.removeEventListener('writing-preferences-changed',load);};
  },[refresh]);
  const current=state?.key===key ? state : undefined;
  async function update(settings:Partial<CompletionPreferences>|null) {
    if(!current?.data || saving.current) return;
    saving.current=true;revision.current++;
    setState({...current,busy:true,error:false});
    let changed=false;
    try {
      const data=await api.saveWritingPreferences(settings,sessionId);
      changed=true;
      if(scope.current===key) setState({key,data});
    } catch {if(scope.current===key)setState({...current,error:true,busy:false});}
    finally {saving.current=false;if(changed || scope.current!==key)window.dispatchEvent(new Event('writing-preferences-changed'));}
  }
  return [current?.data?.effective ?? fallback,update,{loading:!current?.data && !current?.error,error:!!current?.error,busy:!!current?.busy,overrides:current?.data?.overrides ?? null,refresh:()=>refresh()}] as const;
}
