// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(()=>vi.unstubAllGlobals());
const event=(n:number)=>({eventId:`event-${n}`,sessionSeq:n,type:'turn.completed',payload:{},occurredAt:'2026-11-02T00:00:00Z'});
it.each(['codex','claude','grok','cursor','gemini'])('%s refreshes append only new history, keep older pages, and reset on content deletion',async provider=>{
 let epoch=1;let last=1;const urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  urls.push(url);const u=new URL(url,'http://test');let data:unknown;
  if(u.pathname.endsWith('/events')) {
   if(u.searchParams.has('afterSeq')) data={items:last===1?[]:[event(2)],nextAfterSeq:null,throughSeq:last,projectionEpoch:1,contentEpoch:epoch};
   else data={items:epoch===1?[event(1)]:[],nextBeforeSeq:12,throughSeq:last,projectionEpoch:1,contentEpoch:epoch};
  }else if(u.pathname.endsWith('/approvals'))data={approvals:[]};
  else data={session:{logicalSessionId:'s',provider,projectionEpoch:1,contentEpoch:epoch},commands:[],queue:[]};
  return new Response(JSON.stringify(data));
 }));
 const first=await api.session('s');
 expect(first.events.map(e=>e.id)).toEqual(['event-1']);
 const idle=await api.session('s',undefined,first);
 expect(idle.events).toEqual(first.events);
 expect(urls.at(-1)).toContain('afterSeq=1');
 last=2;
 const next=await api.session('s',undefined,idle);
 expect(next.events.map(e=>e.id)).toEqual(['event-1','event-2']);
 expect(next.historyPage?.nextBeforeSeq).toBe(12);
 expect(next.historyPage?.throughSeq).toBe(2);
 epoch=2;
 const deleted=await api.session('s',undefined,next);
 expect(deleted.events).toEqual([]);
 expect(urls.at(-1)).not.toContain('afterSeq');
 expect(urls.filter(u=>u.includes('/events')).every(u=>u.includes('compact=1'))).toBe(true);
});
it('reconnect drains paginated deltas without skipping the cursor between pages',async()=>{
 const cursors:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  const u=new URL(url,'http://test');let data:unknown={session:{logicalSessionId:'s',projectionEpoch:1,contentEpoch:1}};
  if(u.pathname.endsWith('/events')) {
   const after=u.searchParams.get('afterSeq');cursors.push(after??'snapshot');
   data=after==='1'?{items:[event(2)],nextAfterSeq:2,throughSeq:3}:after==='2'?{items:[event(3)],nextAfterSeq:null,throughSeq:3}:{items:[event(1)],throughSeq:1,nextBeforeSeq:null,projectionEpoch:1,contentEpoch:1};
  }
  return new Response(JSON.stringify(data));
 }));
 const first=await api.session('s');const next=await api.session('s',undefined,first);
 expect(cursors).toEqual(['snapshot','1','2']);expect(next.events.map(e=>e.id)).toEqual(['event-1','event-2','event-3']);
});
