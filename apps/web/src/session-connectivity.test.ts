// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {api} from './lib/api';

afterEach(()=>vi.unstubAllGlobals());
it('uses fresh session connectivity without requiring the dashboard host cache',async()=>{
 const until=Date.now()+15000;
 let hostOnline=true;
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>new Response(JSON.stringify(
   path==='/api/sessions/demo' ? {session:{logicalSessionId:'demo',machineId:'host',executionState:'running',reachability:hostOnline?'live':'reconciling',hostOnline,runtimeSyncUntil:hostOnline?null:until}} : {items:[],approvals:[]}
 ),{status:200})));
 const live=await api.session('demo');
 expect(live.hostOnline).toBe(true);
 expect(live.runtimeSyncUntil).toBeNull();
 hostOnline=false;
 const syncing=await api.session('demo');
 expect(syncing.hostOnline).toBe(false);
 expect(syncing.runtimeSyncUntil).toBe(until);
 expect(syncing.session.state.reachability).toBe('reconciling');
 expect(syncing.writable).toBe(false);
});

import {renderHook,act,cleanup} from '@testing-library/react';
import {sessionConnectionHint,useSessionSyncRefresh} from './lib/session-connectivity';
import type {SessionDetail} from './lib/types';
const syncDetail=(until:number):SessionDetail=>({session:{id:'sync-session',state:{ownership:'agentfleet_owned',reachability:'reconciling',unknownFreeze:false}},runtimeSyncUntil:until,hostOnline:false,writable:false,events:[],queue:[]} as unknown as SessionDetail);
afterEach(()=>{cleanup();vi.useRealTimers();});
it('separates connected sync, expired verification and a disconnected host without granting write permission',()=>{
 const d=syncDetail(Date.now()+15000);
 expect(sessionConnectionHint(d)).toContain('主机连接正常');
 expect(sessionConnectionHint(d,Date.now()+16000)).toContain('同步尚未完成');
 expect(sessionConnectionHint({...d,runtimeSyncUntil:null})).toContain('主机连接尚未恢复');
 expect(sessionConnectionHint({...d,runtimeSyncUntil:null,hostOnline:true})).toContain('主机在线');
 expect(sessionConnectionHint({...d,session:{...d.session,state:{...d.session.state,reachability:'live'}}})).toBeNull();
 expect(d.writable).toBe(false);
});
it('sync refresh is read-only, bounded and stops immediately when the session becomes live or switches',async()=>{
 vi.useFakeTimers();const d=syncDetail(Date.now()+3000);const refresh=vi.fn(async()=>{});
 const view=renderHook(({detail})=>useSessionSyncRefresh(detail,refresh),{initialProps:{detail:d}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(refresh).toHaveBeenCalledTimes(1);
 view.rerender({detail:{...d,session:{...d.session,state:{...d.session.state,reachability:'live'}},runtimeSyncUntil:null}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(refresh).toHaveBeenCalledTimes(1);
 view.rerender({detail:syncDetail(Date.now()+2000)});
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(refresh).toHaveBeenCalledTimes(3);
 view.rerender({detail:{...syncDetail(Date.now()+3000),session:{...d.session,id:'another-session'}}});view.unmount();
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(refresh).toHaveBeenCalledTimes(3);
});
it('a slow refresh never overlaps and cannot keep expired sync wording alive',async()=>{
 vi.useFakeTimers();let finish!:()=>void;const refresh=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));const d=syncDetail(Date.now()+2000);
 const view=renderHook(()=>{useSessionSyncRefresh(d,refresh);return sessionConnectionHint(d);});
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(refresh).toHaveBeenCalledTimes(1);expect(view.result.current).toContain('同步尚未完成');
 await act(async()=>{finish();await vi.advanceTimersByTimeAsync(5000);});expect(refresh).toHaveBeenCalledTimes(1);
});
