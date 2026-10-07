// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceTaskInbox} from './components/VoiceTaskInbox';
import {api} from './lib/api';
import type {VoiceTaskPage,VoiceTaskRecord} from './lib/types';
vi.mock('./lib/api',()=>({api:{voiceTasks:vi.fn(),cancelVoiceTodo:vi.fn(),acknowledgeVoiceTodo:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const pending:VoiceTaskRecord={todoId:'todo',intent:'Develop this later',intentUnavailable:false,state:'pending',revision:2,sourceVoiceId:'old-call',createdAt:'2026-01-01',updatedAt:'2026-01-01',target:null,targetUnavailable:false,job:null};
const finished:VoiceTaskRecord={...pending,todoId:'done',intent:'Original completed task',state:'dispatched',target:{machineId:'m',projectId:'p',sessionId:'s',host:'Host',project:'Project',title:'Session'},job:{jobId:'job',nativeTurnId:'turn',state:'completed',result:'Stored result',deliveredToVoice:true,acknowledgedAt:null}};
const page=(items:VoiceTaskRecord[]):VoiceTaskPage=>({items,total:items.length,nextCursor:null,instruction:'Read-only recovery'});
it('opening/restoring memory is read-only; cancels and acknowledgement require explicit clicks',async()=>{
 vi.mocked(api.voiceTasks).mockResolvedValue(page([pending,finished]));
 vi.mocked(api.cancelVoiceTodo).mockResolvedValue({...pending,state:'cancelled'});vi.mocked(api.acknowledgeVoiceTodo).mockResolvedValue(finished);
 const open=vi.fn(),view=render(<VoiceTaskInbox onOpenSession={open}/>);
 expect(api.voiceTasks).not.toHaveBeenCalled();fireEvent.click(screen.getByText('待办与结果记录'));
 expect(await screen.findByText('Develop this later')).toBeTruthy();expect(screen.getByText('Stored result')).toBeTruthy();
 expect(api.cancelVoiceTodo).not.toHaveBeenCalled();expect(api.acknowledgeVoiceTodo).not.toHaveBeenCalled();
 expect(screen.getByText('已送到语音，尚未确认知悉')).toBeTruthy();
 fireEvent.click(screen.getByText('打开目标会话'));expect(open).toHaveBeenCalledWith('s');
 fireEvent.click(screen.getByText('取消待办'));await waitFor(()=>expect(api.cancelVoiceTodo).toHaveBeenCalledWith('todo',2));
 await screen.findByText('标记已知悉');fireEvent.click(screen.getByText('标记已知悉'));await waitFor(()=>expect(api.acknowledgeVoiceTodo).toHaveBeenCalledWith('done'));
 view.unmount();render(<VoiceTaskInbox onOpenSession={open}/>);fireEvent.click(screen.getByText('待办与结果记录'));
 expect(await screen.findByText('Stored result')).toBeTruthy();
});
it('pagination reads older records and a failed load is not shown as an empty inbox',async()=>{
 vi.mocked(api.voiceTasks).mockResolvedValueOnce({...page([pending]),total:21,nextCursor:'20'}).mockResolvedValueOnce(page([finished])).mockRejectedValueOnce(new Error('offline'));
 render(<VoiceTaskInbox onOpenSession={()=>undefined}/>);fireEvent.click(screen.getByText('待办与结果记录'));
 await screen.findByText('Develop this later');fireEvent.click(screen.getByText('下一页'));await screen.findByText('Stored result');
 expect(api.voiceTasks).toHaveBeenLastCalledWith('recover','20',expect.any(AbortSignal));
 fireEvent.click(screen.getByText('刷新记录'));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('暂无语音任务记录')).toBeNull();
});
