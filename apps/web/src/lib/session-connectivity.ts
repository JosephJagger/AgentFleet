import {useEffect,useRef,useState} from 'react';
import type {SessionDetail} from './types';
import {t} from '../i18n';

/** Presentation only. Never make an unreconciled session writable. */
export function sessionConnectionHint(detail:SessionDetail,now=Date.now()):string|null {
  const state=detail.session.state;
  if(state.reachability==='live')return null;
  if(state.ownership!=='agentfleet_owned'||state.unknownFreeze)return null;
  if((detail.runtimeSyncUntil??0)>now)return t('主机连接正常，正在同步会话状态；同步后恢复发送');
  if(detail.runtimeSyncUntil)return t('会话状态同步尚未完成，暂不能发送；草稿已保留');
  if(detail.hostOnline===true)return t('主机在线，正在核验会话状态；草稿已保留');
  return t('主机连接尚未恢复，暂不能发送；草稿已保留');
}

/** Read-only refresh closes the gap when reconciliation completes without a
 * session event. Bound it to the server's existing 15-second continuity window.
 * No task is stored, retried or automatically sent by this hook. */
export function useSessionSyncRefresh(detail:SessionDetail|undefined,refresh:()=>void|Promise<void>):void {
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  const [,setClock]=useState(0);
  const until=detail?.runtimeSyncUntil??0;
  const reconciling=detail?.session.state.reachability==='reconciling';
  useEffect(()=>{
    if(!reconciling||until<=Date.now())return;
    let disposed=false;
    let timer:ReturnType<typeof setTimeout>;
    const deadline=Math.min(until,Date.now()+15_000);
    const tick=async()=>{
      if(disposed)return;
      setClock(value=>value+1);
      try{await refreshRef.current();}catch{/* Keep the draft and write fence. */}
      if(!disposed&&Date.now()<deadline)timer=setTimeout(()=>void tick(),Math.min(1000,deadline-Date.now()));
    };
    timer=setTimeout(()=>void tick(),Math.min(1000,deadline-Date.now()));
    // Expire the optimistic wording even if a read hangs.
    const expiry=setTimeout(()=>{if(!disposed)setClock(value=>value+1);},deadline-Date.now()+1);
    return ()=>{disposed=true;clearTimeout(timer);clearTimeout(expiry);};
  },[detail?.session.id,reconciling,until]);
}
