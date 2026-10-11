import {BuzhoushanHeartbeat} from "./components/BuzhoushanHeartbeat";
import {isConversationEvent} from "./lib/buzhoushan-events";
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
it('supports idle history with one read, selection without stealing focus, collapse and keyboard resizing',()=>{
 const d=detail();d.session.activeTurnId=undefined;d.session.state.currentTurn='none';d.events=[{id:'one',sessionSeq:1,type:'item.completed',occurredAt:'2026-01-01',command:'npm test',output:'test output',status:'completed'}];
 const view=render(<BuzhoushanActivity detail={d}/>);
 expect(api.sessionProgress).toHaveBeenCalledTimes(1);expect(screen.queryByText('实时更新')).toBeNull();
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
it('merges durable file changes with command progress and restores idle activity with a single read',async()=>{
 const d=detail();d.events=[{id:'file-event',nativeItemId:'file',nativeTurnId:'turn-a',sessionSeq:1,type:'item.completed',occurredAt:'2026-01-01',fileChanges:[{path:'src/demo.ts',diff:'+ real change'}]}];
 expect(workbenchItems(d,progress).map(item=>item.kind)).toEqual(['fileChange','commandExecution']);
 d.session.activeTurnId=undefined;d.session.state.currentTurn='none';d.events=[];
 vi.mocked(api.sessionProgress).mockResolvedValue({...progress,state:'completed',freshness:'stale',items:progress.items.map(item=>({...item,status:'completed'}))});
 render(<BuzhoushanActivity detail={d}/>);await act(async()=>{});
 expect(screen.getByText(/partial check output/)).toBeTruthy();
 expect(screen.getByText('最后已知进度')).toBeTruthy();
 expect(api.sessionProgress).toHaveBeenCalledTimes(1);
 expect(vi.mocked(api.sessionProgress).mock.calls[0][2]).toBe(true);
});

it('keeps terminal commands and file edits in distinct tabs without a duplicate aggregate',async()=>{
 vi.mocked(api.sessionProgress).mockResolvedValue({...progress,items:[...progress.items,{id:'edit',kind:'fileChange',status:'completed',title:'src/example.ts',output:'+ changed',updatedAt:progress.updatedAt!}]});
 render(<BuzhoushanActivity detail={detail()}/>);await act(async()=>{});
 expect(screen.queryByRole('button',{name:'代码活动'})).toBeNull();
 expect(screen.getByText(/partial check output/)).toBeTruthy();
 expect(screen.queryByText(/changed/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'文件修改'}));
 expect(screen.getByText(/changed/)).toBeTruthy();
 expect(screen.queryByText(/partial check output/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重置活动布局'}));
 expect(screen.getByRole('button',{name:'终端'}).getAttribute('aria-pressed')).toBe('true');
});

it('keeps reasoning and command output in the terminal and conversation text in chat',()=>{
 const d=detail();const base={sessionSeq:1,occurredAt:'2026-01-01',nativeTurnId:'turn-a',type:'item.completed'};
 d.events=[{...base,id:'reason',actor:'agent',itemType:'reasoning',body:'public reasoning summary'}, {...base,id:'reply',actor:'agent',itemType:'agentMessage',body:'Reply'}, {...base,id:'user',actor:'user',itemType:'userMessage',body:'Request'}, {...base,id:'cmd',itemType:'commandExecution',command:'npm test',output:'checks'}];
 expect(d.events.filter(isConversationEvent).map(e=>e.id)).toEqual(['reply','user']);
 expect(workbenchItems(d).map(e=>e.id)).toEqual(['reason','cmd']);
 expect(workbenchItems(d)[0].output).toBe('public reasoning summary');
});
it('keeps heartbeat through reasoning without a timer and hides for replies, offline and completion',()=>{
 vi.useFakeTimers();const d=detail();
 const view=render(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
 expect(screen.getByRole('status')).toBeTruthy();
 const messages=[{id:'reply',sessionSeq:1,type:'agent_message.delta',actor:'agent' as const,nativeTurnId:'turn-a',body:'Writing reply',occurredAt:'2026-01-01'}];
 view.rerender(<BuzhoushanHeartbeat detail={d} messages={messages}/>);
 expect(screen.queryByRole('status')).toBeNull();
 act(()=>vi.advanceTimersByTime(60_000));expect(screen.queryByRole('status')).toBeNull();
 d.events=[{id:'reason',sessionSeq:2,type:'item.started',itemType:'reasoning',nativeTurnId:'turn-a',occurredAt:'2026-01-01'}];view.rerender(<BuzhoushanHeartbeat detail={d} messages={messages}/>);expect(screen.getByRole('status')).toBeTruthy();
 act(()=>vi.advanceTimersByTime(60_000));expect(screen.getByRole('status')).toBeTruthy();
 d.session.state.waitReason='approval';view.rerender(<BuzhoushanHeartbeat detail={d} messages={messages}/>);expect(screen.getByRole('status').textContent).toContain('等待确认');
 d.session.state.waitReason='none';d.hostOnline=false;view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();
 d.hostOnline=true;d.session.activeTurnId=undefined;d.session.state.currentTurn='none';view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();
});
it('shows workspace snapshot provenance and explicit unsupported state in file changes',async()=>{
 vi.mocked(api.sessionProgress).mockResolvedValue({...progress,items:[{id:'workspace',kind:'fileChange',source:'workspace_snapshot',supported:false,limited:true,status:'completed',title:'',updatedAt:progress.updatedAt!}]});
 render(<BuzhoushanActivity detail={detail()}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'文件修改'}));
 expect(screen.getByText(/此工作区暂无法采集/)).toBeTruthy();
 expect(screen.getByText(/可能包含其他程序同期写入/)).toBeTruthy();
});
