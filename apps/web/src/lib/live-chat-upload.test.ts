import {it,expect,vi,afterEach} from 'vitest';
import {LiveChatUpload} from './live-chat-upload';
import type {LiveEvent} from './live-interactions';
const event=(id:string,type:LiveEvent['type']='chat'):LiveEvent=>({id,type,roomId:'room',userId:'viewer',name:'合成观众',content:'合成问题',receivedAt:Date.now(),sourceObservedAt:Date.now(),collector:'companion-log',ownerId:'',ownerName:'',roomTitle:''});
afterEach(()=>vi.useRealTimers());
it('uploads only real chat, keeps three different messages by the same viewer, and bounds batches',async()=>{
 const send=vi.fn().mockResolvedValue({});const q=new LiveChatUpload(send);q.add(event('entry','enter'));
 for(let i=0;i<25;i++)q.add(event(String(i)));expect(await q.flush()).toBe('saved');expect(send.mock.calls[0][0]).toHaveLength(20);
 await q.flush();expect(send.mock.calls[1][0]).toHaveLength(5);expect(await q.flush()).toBeNull();
});
it('failed upload retries bounded evidence and cancellation never crosses account lifecycle',async()=>{
 vi.useFakeTimers();const send=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});const q=new LiveChatUpload(send);
 q.add(event('one'));expect(await q.flush()).toBe('failed');expect(await q.flush()).toBeNull();vi.advanceTimersByTime(5000);expect(await q.flush()).toBe('saved');expect(send.mock.calls[1][0][0].id).toBe('one');
 q.add(event('discard'));q.clear();expect(await q.flush()).toBeNull();
 let reject!:(error:Error)=>void;const slow=new LiveChatUpload((_batch,signal)=>new Promise((_,r)=>{reject=r;signal.addEventListener('abort',()=>r(new Error('abort')));}));slow.add(event('old'));const pending=slow.flush();slow.clear();reject(new Error('late'));expect(await pending).toBeNull();expect(await slow.flush()).toBeNull();
});
