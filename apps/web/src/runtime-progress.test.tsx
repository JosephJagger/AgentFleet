// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProgress } from './components/RuntimeProgress';
import { api } from './lib/api';
import type { SessionProgress } from './lib/types';
vi.mock('./lib/api',()=>({api:{sessionProgress:vi.fn()}}));
const progress:SessionProgress={sessionId:'session-a',nativeTurnId:'turn-a',state:'running',source:'codex_app_server_events',freshness:'live',updatedAt:'2026-01-01T00:00:00Z',contentAvailable:true,waitingForApproval:false,limited:false,items:[{id:'command',kind:'commandExecution',status:'running',title:'npm test',output:'checking module 1',updatedAt:'2026-01-01T00:00:00Z'}]};
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();});
it('shows partial progress before completion, marks failed polls stale and stops when inactive',async()=>{
  vi.useFakeTimers();vi.mocked(api.sessionProgress).mockResolvedValue(progress);
  const view=render(<RuntimeProgress sessionId="session-a" active/>);
  await act(async()=>{});
  expect(screen.getByText('checking module 1')).toBeTruthy();
  expect(screen.getByText('实时更新')).toBeTruthy();
  vi.mocked(api.sessionProgress).mockRejectedValueOnce(new Error('offline'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(screen.getByText('进度暂时无法更新')).toBeTruthy();
  expect(screen.getByText('checking module 1')).toBeTruthy();
  view.rerender(<RuntimeProgress sessionId="session-a" active={false}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(api.sessionProgress).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('运行进度')).toBeNull();
});
it('aborts the old session request and rejects a response for another session',async()=>{
  let complete!:(value:SessionProgress)=>void;
  vi.mocked(api.sessionProgress).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;})).mockResolvedValue(progress);
  const view=render(<RuntimeProgress sessionId="session-a" active/>);
  const signal=vi.mocked(api.sessionProgress).mock.calls[0][1]!;
  view.rerender(<RuntimeProgress sessionId="session-b" active/>);
  await act(async()=>{complete(progress);});
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText('checking module 1')).toBeNull();
});
