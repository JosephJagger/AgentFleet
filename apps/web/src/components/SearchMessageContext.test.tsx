// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchMessageContext } from './SearchMessageContext';
import { api } from '../lib/api';
import type { FleetSession, TimelineEvent } from '../lib/types';
vi.mock('../lib/api',()=>({api:{searchContext:vi.fn(),history:vi.fn(),historyForward:vi.fn()}}));
const session={id:'remote',projectionEpoch:1,contentEpoch:1} as FleetSession;
const event=(id:string,seq:number,text:string):TimelineEvent=>({id,sessionSeq:seq,type:'item.completed',nativeThreadId:'claude_native',nativeItemId:id,nativeTurnId:'turn',itemType:'agentMessage',actor:'agent',body:text,occurredAt:'2026-11-04T00:00:00Z',payloadState:'present'});
const context={events:[event('target',60,'命中的旧消息'),event('after',61,'后续上下文')],nextBeforeSeq:60,nextAfterSeq:61,projectionEpoch:1,contentEpoch:1};
afterEach(()=>{cleanup();vi.resetAllMocks();});
function mount(){const exit=vi.fn();const view=render(<SearchMessageContext session={session} eventId="target" onReturnToLatest={exit} renderEvents={(events,id)=><>{events.map(e=><article key={e.id} data-scroll-anchor={e.id} data-search-hit={e.id===id}>{e.body}</article>)}</>}/>);return {...view,exit};}
it('uses an event anchor and highlights the projected native message, without fetching all history',async()=>{
  vi.mocked(api.searchContext).mockResolvedValue(context);const {exit}=mount();
  const target=await screen.findByText('命中的旧消息');expect(target.getAttribute('data-search-hit')).toBe('true');
  expect(api.searchContext).toHaveBeenCalledWith('remote','target',expect.any(AbortSignal));expect(api.history).not.toHaveBeenCalled();
  vi.mocked(api.historyForward).mockResolvedValue({events:[event('next',62,'再下一条')],nextAfterSeq:null});
  fireEvent.click(screen.getByRole('button',{name:'加载后续记录'}));await screen.findByText('再下一条');
  expect(api.historyForward).toHaveBeenCalledWith('remote',61,1,1,expect.any(AbortSignal));
  expect(screen.getByText('命中的旧消息')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button',{name:/回到最新|新消息/})[0]);expect(exit).toHaveBeenCalledOnce();
});
it('expired or inaccessible hits show an explicit failure and never silently open latest history',async()=>{
  vi.mocked(api.searchContext).mockRejectedValue(new Error('expired'));mount();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('可能已过期或删除'));
  expect(api.history).not.toHaveBeenCalled();expect(screen.queryByRole('region',{name:'会话记录'})).toBeNull();
});
it('aborts requests on navigation and rejects a changed content epoch',async()=>{
  vi.mocked(api.searchContext).mockResolvedValue({...context,contentEpoch:2});const {unmount}=mount();
  await screen.findByRole('alert');const signal=vi.mocked(api.searchContext).mock.calls[0][2]!;
  unmount();await waitFor(()=>expect(signal.aborted).toBe(true));
});
