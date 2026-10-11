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
