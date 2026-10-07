// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PanelVoiceControl} from './components/PanelVoiceControl';
import type {Machine} from './lib/types';
import type {PanelVoiceTask} from './components/NativeVoicePanel';
vi.mock('./lib/use-draggable-panel',()=>({useDraggablePanel:()=>({style:{},handle:{}})}));
vi.mock('./components/NativeVoicePanel',()=>({NativeVoicePanel:({canStart,onPanelTask}:{canStart:boolean;onPanelTask:(task:PanelVoiceTask|undefined)=>void})=><>
 <button disabled={!canStart}>Test call</button>
 <button onClick={()=>onPanelTask({jobId:'job',sessionId:'session',title:'Book',project:'Demo',host:'Host',state:'failed',result:'',link:'/sessions/session',executionStarted:false,historyLimited:false,error:{code:'MACHINE_DRAINING',message:'waiting for maintenance'}})}>Fail task</button>
 <button onClick={()=>onPanelTask({jobId:'job-two',sessionId:'session-two',title:'Other project',project:'Other',host:'Host',state:'running',result:'',link:'/sessions/session-two'})}>Second task</button>
 <button onClick={()=>onPanelTask(undefined)}>New call</button>
</>}));
afterEach(cleanup);
const machine={id:'host',name:'Host',agentVersion:'0.30.86',reachability:'live'} as Machine;
it('maintenance explains why a connected host cannot start voice and recovers on a fresh report',()=>{
 const props={machines:[{...machine,maintenance:{operationId:'upgrade',startedAt:'2026-01-01T00:00:00Z'}}],onOpenSession:vi.fn()};
 const view=render(<PanelVoiceControl {...props}/>);fireEvent.click(screen.getByRole('button',{name:'面板语音总控'}));
 expect(screen.getByRole('button',{name:'Test call'}).hasAttribute('disabled')).toBe(true);
 expect(screen.getByRole('status').textContent).toContain('等待安全重启');
 view.rerender(<PanelVoiceControl {...props} machines={[machine]}/>);
 expect(screen.getByRole('button',{name:'Test call'}).hasAttribute('disabled')).toBe(false);
});
it('failed tasks show their real code and unstarted state without claiming history loss; new calls clear old results',()=>{
 const open=vi.fn();render(<PanelVoiceControl machines={[machine]} onOpenSession={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'面板语音总控'}));fireEvent.click(screen.getByText('Fail task'));
 fireEvent.click(screen.getByRole('button',{name:'0 运行中'}));
 expect(screen.getByRole('alert',{hidden:true}).textContent).toContain('MACHINE_DRAINING');expect(screen.getByText('任务未启动')).toBeTruthy();
 expect(screen.queryByText('部分任务历史不可用')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Book Host · Demo'}));expect(open).toHaveBeenCalledWith('session');
 fireEvent.click(screen.getByText('New call'));expect(screen.queryByText('Book')).toBeNull();
});

it('parallel task cards keep separate states and navigation targets',()=>{
 const open=vi.fn();render(<PanelVoiceControl machines={[machine]} onOpenSession={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'面板语音总控'}));fireEvent.click(screen.getByText('Fail task'));fireEvent.click(screen.getByText('Second task'));
 fireEvent.click(screen.getByRole('button',{name:'1 运行中'}));
 const first=screen.getByText('Book').closest('.panel-voice-control__task') as HTMLElement;
 const second=screen.getByText('Other project').closest('.panel-voice-control__task') as HTMLElement;
 expect(within(first).getByText('失败')).toBeTruthy();expect(within(second).getByText('执行中')).toBeTruthy();
 fireEvent.click(within(first).getByRole('button'));fireEvent.click(within(second).getByRole('button'));
 expect(open.mock.calls).toEqual([['session'],['session-two']]);
 fireEvent.click(screen.getByText('Fail task'));expect(screen.getAllByText('Book')).toHaveLength(1);expect(screen.getByText('Other project')).toBeTruthy();
 fireEvent.click(screen.getByText('New call'));expect(screen.queryByText('Other project')).toBeNull();
});

it('keeps the overview compact and updates counts without confusing completed or failed jobs with running work',()=>{
 const open=vi.fn();render(<PanelVoiceControl machines={[machine]} onOpenSession={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'面板语音总控'}));
 expect(screen.getByRole('button',{name:'0 运行中'}).getAttribute('aria-expanded')).toBe('false');
 fireEvent.click(screen.getByText('Second task'));
 const overview=screen.getByRole('button',{name:'1 运行中'});
 expect(screen.queryByRole('button',{name:'Other project Host · Other'})).toBeNull();
 fireEvent.click(overview);
 fireEvent.click(screen.getByRole('button',{name:'Other project Host · Other'}));
 expect(open).toHaveBeenLastCalledWith('session-two');
 fireEvent.click(screen.getByText('Fail task'));
 expect(screen.getByRole('button',{name:'1 运行中'})).toBeTruthy();
 fireEvent.click(screen.getByText('Second task'));
 expect(screen.getAllByRole('button',{name:'Other project Host · Other'})).toHaveLength(1);
 fireEvent.click(screen.getByText('New call'));
 expect(screen.getByRole('button',{name:'0 运行中'})).toBeTruthy();
 expect(screen.getByText('暂无本次通话派发的任务')).toBeTruthy();
});
