import {preserveBuzhoushanStream} from "./lib/buzhoushan-stream";
import {BuzhoushanHeartbeat} from "./components/BuzhoushanHeartbeat";
import {isConversationEvent,isBuzhoushanChatEvent} from "./lib/buzhoushan-events";
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
 fireEvent.click(screen.getByRole("button",{name:"展开代码活动"}));
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
 fireEvent.click(screen.getByRole("button",{name:"展开代码活动"}));
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
 fireEvent.click(screen.getByRole("button",{name:"展开代码活动"}));
 expect(screen.getByText(/partial check output/)).toBeTruthy();
 expect(screen.getByText('最后已知进度')).toBeTruthy();
 expect(api.sessionProgress).toHaveBeenCalledTimes(1);
 expect(vi.mocked(api.sessionProgress).mock.calls[0][2]).toBe(true);
});

it('keeps terminal commands and file edits in distinct tabs without a duplicate aggregate',async()=>{
 vi.mocked(api.sessionProgress).mockResolvedValue({...progress,items:[...progress.items,{id:'edit',kind:'fileChange',status:'completed',title:'src/example.ts',output:'+ changed',updatedAt:progress.updatedAt!}]});
 render(<BuzhoushanActivity detail={detail()}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'展开代码活动'}));
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
it('holds streaming replies through pauses and interleaved reasoning, then waits one second after completion',()=>{
 vi.useFakeTimers();const d=detail();
 const view=render(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
 const mode=()=>screen.getByRole('status').getAttribute('data-mode');
 expect(mode()).toBe('heartbeat');
 const delta={id:'delta',nativeItemId:'reply',sessionSeq:1,type:'agent_message.delta',actor:'agent' as const,nativeTurnId:'turn-a',body:'Writing',occurredAt:'2026-01-01'};
 d.events=[delta];view.rerender(<BuzhoushanHeartbeat detail={d} messages={[delta]}/>);expect(mode()).toBe('reply');
 const process={id:'reason',sessionSeq:2,type:'item.started',itemType:'reasoning',nativeTurnId:'turn-a',occurredAt:'2026-01-01'};
 d.events.push(process);view.rerender(<BuzhoushanHeartbeat detail={d} messages={[delta]}/>);
 act(()=>vi.advanceTimersByTime(60_000));expect(mode()).toBe('reply');expect(screen.getByRole('status').getAttribute('aria-label')).toBe('正在回复');
 const complete={...delta,id:'complete',sessionSeq:3,type:'item.completed',itemType:'agentMessage',body:'Writing reply finished'};
 d.events.push(complete,{...process,id:'tool',sessionSeq:4,itemType:'commandExecution'});
 view.rerender(<BuzhoushanHeartbeat detail={d} messages={[complete]}/>);expect(mode()).toBe('settling');
 act(()=>vi.advanceTimersByTime(999));expect(mode()).toBe('settling');
 act(()=>vi.advanceTimersByTime(1));expect(mode()).toBe('heartbeat');
 d.session.state.waitReason='approval';view.rerender(<BuzhoushanHeartbeat detail={d} messages={[complete]}/>);expect(screen.getByRole('status').getAttribute('aria-label')).toBe('等待确认');
});
it('completed replies restore heartbeat after one second without another process event',()=>{
 vi.useFakeTimers();const d=detail();
 const complete={id:'complete',nativeItemId:'reply',sessionSeq:1,type:'item.completed',itemType:'agentMessage',nativeTurnId:'turn-a',body:'Reply',occurredAt:'2026-01-01'};
 d.events=[complete];const view=render(<BuzhoushanHeartbeat detail={d} messages={[complete]}/>);
 act(()=>vi.advanceTimersByTime(999));expect(screen.getByRole('status').getAttribute('data-mode')).toBe('settling');
 act(()=>vi.advanceTimersByTime(1));expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
 const delta={...complete,id:'delta',nativeItemId:'second',type:'agent_message.delta',sessionSeq:3};
 d.events.push({...complete,id:'process',itemType:'reasoning',sessionSeq:2},delta);
 view.rerender(<BuzhoushanHeartbeat detail={d} messages={[complete,delta]}/>);
 act(()=>vi.advanceTimersByTime(10_000));expect(screen.getByRole('status').getAttribute('data-mode')).toBe('reply');
 // Out-of-order duplicate deltas cannot reopen a completed native message.
 d.events.push({...delta,id:'second-complete',type:'item.completed',sessionSeq:4},{...delta,id:'late',sessionSeq:5});
 view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.getByRole('status').getAttribute('data-mode')).toBe('settling');
});
it('stops immediately on terminal events, offline, frozen state and turn change without stale timers',()=>{
 vi.useFakeTimers();
 for(const type of ['turn.completed','turn.failed','turn.interrupted','turn.cancelled']){
 const d=detail();const view=render(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
 d.events=[{id:'end',sessionSeq:1,type,nativeTurnId:'turn-a',occurredAt:'2026-01-01'}];view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();view.unmount();
 }
 const d=detail();const view=render(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
 d.hostOnline=false;view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();
 d.hostOnline=true;d.session.state.unknownFreeze=true;view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();
 d.session.state.unknownFreeze=false;d.session.activeTurnId='next';view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
 d.session.activeTurnId=undefined;d.session.state.currentTurn='none';view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);expect(screen.queryByRole('status')).toBeNull();
});
it('preserves unfinished native text through snapshots, but not completion, deletion or scope changes',()=>{
 const d=detail();const delta={id:'delta',nativeItemId:'reply',nativeTurnId:'turn-a',sessionSeq:2,type:'agent_message.delta',body:'partial',occurredAt:'2026-01-01'};d.events=[delta];
 const snapshot=detail();expect(preserveBuzhoushanStream(d,snapshot).events).toEqual([delta]);
 expect(preserveBuzhoushanStream(d,{...snapshot,events:[{...delta,id:'done',type:'item.completed'}]}).events).toHaveLength(1);
 expect(preserveBuzhoushanStream(d,{...snapshot,events:[{...delta,id:'delete',payloadState:'deleted'}]}).events).toHaveLength(1);
 for(const patch of [{id:'other'},{activeTurnId:'other'},{nativeThreadId:'other'},{contentEpoch:2},{projectionEpoch:2},{cloudImageRevision:10}]){
 expect(preserveBuzhoushanStream(d,{...snapshot,session:{...snapshot.session,...patch}}).events).toEqual([]);
 }
 expect(preserveBuzhoushanStream(d,{...snapshot,progress:{...progress,contentAvailable:false}}).events).toEqual([]);
 expect(preserveBuzhoushanStream(d,{...snapshot,events:[{...delta,id:'end',type:'turn.completed'}]}).events).toHaveLength(1);
});
it('shows workspace snapshot provenance and explicit unsupported state in file changes',async()=>{
 vi.mocked(api.sessionProgress).mockResolvedValue({...progress,items:[{id:'workspace',kind:'fileChange',source:'workspace_snapshot',supported:false,limited:true,status:'completed',title:'',updatedAt:progress.updatedAt!}]});
 render(<BuzhoushanActivity detail={detail()}/>);await act(async()=>{});
 fireEvent.click(screen.getByRole('button',{name:'文件修改'}));
 expect(screen.getByText(/此工作区暂无法采集/)).toBeTruthy();
 expect(screen.getByText(/可能包含其他程序同期写入/)).toBeTruthy();
});

it('keeps dock closed across turn start and completion until the user opens it',async()=>{
 vi.mocked(api.sessionProgress).mockResolvedValue(progress);
 const d=detail();const view=render(<BuzhoushanActivity detail={d}/>);await act(async()=>{});
 expect(screen.queryByRole('separator')).toBeNull();
 d.session.activeTurnId=undefined;d.session.state.currentTurn='none';view.rerender(<BuzhoushanActivity detail={d}/>);
 expect(screen.queryByRole('separator')).toBeNull();
 d.session.activeTurnId='next';d.session.state.currentTurn='in_progress';view.rerender(<BuzhoushanActivity detail={d}/>);
 expect(screen.queryByRole('separator')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重置活动布局'}));expect(screen.queryByRole('separator')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'终端'}));expect(screen.getByRole('separator')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'收起代码活动'}));
 fireEvent.click(screen.getByText('最后已知进度'));expect(screen.getByRole('separator')).toBeTruthy();
});

it('cancels the one-second completion timer when another message starts',()=>{
 vi.useFakeTimers();const d=detail();
 const done={id:'done',nativeItemId:'one',nativeTurnId:'turn-a',sessionSeq:1,type:'item.completed',itemType:'agentMessage',body:'First',occurredAt:'2026-01-01'};
 d.events=[done,{...done,id:'tool',nativeItemId:'tool',itemType:'commandExecution',sessionSeq:2}];
 const view=render(<BuzhoushanHeartbeat detail={d} messages={[done]}/>);
 act(()=>vi.advanceTimersByTime(500));
 const next={...done,id:'next',nativeItemId:'two',type:'agent_message.delta',sessionSeq:3,body:'Second'};
 d.events.push(next);view.rerender(<BuzhoushanHeartbeat detail={d} messages={[done,next]}/>);
 act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('status').getAttribute('data-mode')).toBe('reply');
 view.unmount();expect(vi.getTimerCount()).toBe(0);
});

it('shows turn outcomes in workbench chat while reasoning and commands remain in terminal',()=>{
 const base={id:'event',sessionSeq:1,occurredAt:'2026-01-01'};
 for(const type of ['turn.completed','turn.failed','turn.interrupted','turn.cancelled']) expect(isBuzhoushanChatEvent({...base,type})).toBe(true);
 for(const itemType of ['reasoning','commandExecution','fileChange']) expect(isBuzhoushanChatEvent({...base,type:'item.completed',itemType})).toBe(false);
 expect(isBuzhoushanChatEvent({...base,type:'item.completed',itemType:'agentMessage'})).toBe(true);
});

it('reasoning lifecycle and duplicate completion receipts never restart a settled heartbeat',()=>{
 vi.useFakeTimers();const d=detail();
 const done={id:'done',nativeItemId:'reply',sessionSeq:1,type:'item.completed',itemType:'agentMessage',actor:'agent' as const,nativeTurnId:'turn-a',body:'Progress update',occurredAt:'2026-01-01'};
 d.events=[done];const view=render(<BuzhoushanHeartbeat detail={d} messages={[done]}/>);
 act(()=>vi.advanceTimersByTime(1000));
 for(const type of ['item.started','item.completed','message','agent_message.delta']) {
  const reason={...done,id:`reason-${type}`,nativeItemId:'reason',sessionSeq:d.events.length+1,type,itemType:'reasoning',body:'Reasoning summary'};
  d.events.push(reason);view.rerender(<BuzhoushanHeartbeat detail={d} messages={[done,reason]}/>);
  expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
 }
 d.events.push({...done,id:'duplicate',sessionSeq:99});
 view.rerender(<BuzhoushanHeartbeat detail={d} messages={[done]}/>);
 expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
});

it('empty reply lifecycle cannot pause heartbeat without visible reply text',()=>{
 vi.useFakeTimers();const d=detail();const view=render(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
 for(const type of ['item.started','item.completed']) {
  d.events.push({id:type,nativeItemId:'empty',sessionSeq:d.events.length+1,type,itemType:'agentMessage',actor:'agent',nativeTurnId:'turn-a',body:'   ',occurredAt:'2026-01-01'});
  view.rerender(<BuzhoushanHeartbeat detail={d} messages={[]}/>);
  expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
 }
});
it('a replayed started item cannot reopen an already completed reply',()=>{
 vi.useFakeTimers();const d=detail();const done={id:'done',nativeItemId:'reply',sessionSeq:1,type:'item.completed',itemType:'agentMessage',actor:'agent' as const,nativeTurnId:'turn-a',body:'Complete',occurredAt:'2026-01-01'};
 d.events=[done];const view=render(<BuzhoushanHeartbeat detail={d} messages={[done]}/>);act(()=>vi.advanceTimersByTime(1000));
 d.events.push({...done,id:'late-start',sessionSeq:3,type:'item.started'});view.rerender(<BuzhoushanHeartbeat detail={d} messages={[done]}/>);
 expect(screen.getByRole('status').getAttribute('data-mode')).toBe('heartbeat');
});
