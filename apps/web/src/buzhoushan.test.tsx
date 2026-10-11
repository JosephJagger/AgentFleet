// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {BuzhoushanActivity, workbenchItems} from './components/BuzhoushanActivity';
import {useBuzhoushanDesktop} from './lib/buzhoushan';
import {setTheme} from './lib/theme';
import {api} from './lib/api';
import type {SessionDetail, SessionProgress} from './lib/types';
vi.mock('./lib/api',()=>({api:{sessionProgress:vi.fn()}}));
const progress:SessionProgress={sessionId:'a',nativeTurnId:'turn-a',state:'running',source:'native',freshness:'live',updatedAt:'2026-01-01T00:00:00Z',contentAvailable:true,waitingForApproval:false,limited:false,items:[{id:'one',kind:'commandExecution',status:'running',title:'npm test',output:'partial check output',updatedAt:'2026-01-01T00:00:00Z'}]};
const detail=(id='a'):SessionDetail=>({session:{id,title:'Synthetic task',machineId:'demo',machineName:'Demo',projectId:'project',projectAlias:'Project',nativeThreadId:id,activeTurnId:'turn-'+id,historyMode:'legacy',state:{ownership:'agentfleet_owned',threadRuntime:'active',currentTurn:'in_progress',waitReason:'none',reachability:'live',history:'complete',unknownFreeze:false},lastActivityAt:'2026-01-01',sessionSeq:1,projectionEpoch:1,contentEpoch:1,executionSegmentId:id,threadControlVersion:1,turnControlVersion:1,projectLeaseVersion:1,controlLeaseVersion:0,queueVersion:0},events:[],queue:[],hostOnline:true,writable:true});
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();vi.unstubAllGlobals();localStorage.clear();setTheme('daylight');});
it('filters suppressed payloads, foreign turns, wrong sessions and content-disabled progress',()=>{
 const d=detail();d.events=[{id:'old',sessionSeq:1,type:'item.completed',occurredAt:'2026-01-01',nativeTurnId:'old-turn',command:'old secret'}, {id:'hidden',sessionSeq:2,type:'item.completed',occurredAt:'2026-01-01',nativeTurnId:'turn-a',command:'hidden secret',payloadState:'deleted'}];
 expect(workbenchItems(d,{...progress,sessionId:'b'})).toEqual([]);
 expect(workbenchItems(d,{...progress,nativeTurnId:'old-turn'})).toEqual([]);
 expect(workbenchItems(d,{...progress,contentAvailable:false})).toEqual([]);
 expect(workbenchItems(d,progress)[0].title).toBe('npm test');
});
it('uses one progress poller, shows ongoing output, marks failure stale, and aborts on session change',async()=>{
 vi.useFakeTimers();vi.mocked(api.sessionProgress).mockResolvedValue(progress);
 const view=render(<BuzhoushanActivity key="a" detail={detail()}/>);await act(async()=>{});
 expect(screen.getByText(/partial check output/)).toBeTruthy();expect(screen.getByText('实时更新')).toBeTruthy();
 expect(api.sessionProgress).toHaveBeenCalledTimes(1);
 vi.mocked(api.sessionProgress).mockRejectedValueOnce(new Error('offline'));
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(screen.getByText('进度暂时无法更新')).toBeTruthy();
 const oldSignal=vi.mocked(api.sessionProgress).mock.calls[0][1]!;
 view.rerender(<BuzhoushanActivity key="b" detail={detail('b')}/>);await act(async()=>{});
 expect(oldSignal.aborted).toBe(true);expect(screen.queryByText(/partial check output/)).toBeNull();
});
it('supports idle history without polling, selection without stealing focus, collapse and keyboard resizing',()=>{
 const d=detail();d.session.activeTurnId=undefined;d.session.state.currentTurn='none';d.events=[{id:'one',sessionSeq:1,type:'item.completed',occurredAt:'2026-01-01',command:'npm test',output:'test output',status:'completed'}];
 const view=render(<BuzhoushanActivity detail={d}/>);
 expect(api.sessionProgress).not.toHaveBeenCalled();expect(screen.queryByText('实时更新')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/npm test 已完成/}));
 view.rerender(<BuzhoushanActivity detail={{...d,events:[...d.events,{...d.events[0],id:'two',command:'npm run build',output:'build output'}]}}/>);
 expect(screen.getByText(/test output/)).toBeTruthy();expect(screen.queryByText(/build output/)).toBeNull();
 const separator=screen.getByRole('separator');const before=Number(separator.getAttribute('aria-valuenow'));fireEvent.keyDown(separator,{key:'ArrowUp'});expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
 fireEvent.click(screen.getByRole('button',{name:'收起代码活动'}));expect(screen.queryByRole('separator')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'展开代码活动'}));fireEvent.click(screen.getByRole('button',{name:'重置活动布局'}));expect(screen.getByText(/build output/)).toBeTruthy();
});
it('activates only for the new theme on desktop',()=>{
 let desktop=false;let changed=()=>{};
 vi.stubGlobal('matchMedia',()=>({matches:desktop,addEventListener:(_name:string,fn:()=>void)=>{changed=fn;},removeEventListener:()=>{}}));
 function Probe(){return <span>{useBuzhoushanDesktop()?'workbench':'existing'}</span>}
 setTheme('buzhoushan');render(<Probe/>);expect(screen.getByText('existing')).toBeTruthy();
 act(()=>{desktop=true;changed();});expect(screen.getByText('workbench')).toBeTruthy();
 act(()=>{setTheme('official');});expect(screen.getByText('existing')).toBeTruthy();
});
