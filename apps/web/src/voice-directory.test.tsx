// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceDirectory} from './components/VoiceDirectory';
import {api} from './lib/api';
vi.mock('./lib/api',()=>({api:{voiceDirectory:vi.fn()}}));
const page={generatedAt:'2026-01-01T00:00:00Z',hostTotal:1,hostsTruncated:false,hosts:[{id:'host',name:'Demo Host',heartbeatAt:null}],total:1,nextCursor:null,sessions:[{id:'session',title:'Demo task',provider:'codex',host:'Demo Host',project:'Demo project',managed:true,executionState:'running',freshness:'live',hostHeartbeatAt:null,sessionUpdatedAt:'2026-01-01T00:00:00Z'}]};
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();});
async function tick(ms=310){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}
async function expand(){const details=screen.getByText('主机与会话目录').parentElement!;details.setAttribute('open','');fireEvent(details,new Event('toggle'));await tick();return details;}
it('loads metadata only on expansion, combines filters, opens exact identity, stops polling on collapse',async()=>{
 vi.useFakeTimers();vi.mocked(api.voiceDirectory).mockResolvedValue(page);const open=vi.fn();render(<VoiceDirectory onOpenSession={open}/>);
 await tick();expect(api.voiceDirectory).not.toHaveBeenCalled();const details=await expand();expect(api.voiceDirectory).toHaveBeenCalledTimes(1);
 fireEvent.change(screen.getByLabelText('组合搜索'),{target:{value:'Demo Host project'}});await tick();expect(api.voiceDirectory).toHaveBeenLastCalledWith(expect.objectContaining({query:'Demo Host project',directoryStatus:'active'}),expect.any(AbortSignal));
 fireEvent.click(screen.getByRole('button',{name:/Demo task/}));expect(open).toHaveBeenCalledWith('session');
 await tick(15000);const count=vi.mocked(api.voiceDirectory).mock.calls.length;details.removeAttribute('open');fireEvent(details,new Event('toggle'));await tick(30000);expect(api.voiceDirectory).toHaveBeenCalledTimes(count);
});
it('failed refresh marks old directory stale and disables old navigation',async()=>{
 vi.useFakeTimers();vi.mocked(api.voiceDirectory).mockResolvedValueOnce(page).mockRejectedValue(new Error('offline'));render(<VoiceDirectory onOpenSession={vi.fn()}/>);await expand();
 fireEvent.click(screen.getByRole('button',{name:'刷新目录'}));await tick();expect(screen.getByRole('alert').textContent).toContain('可能已过期');expect(screen.getByRole('button',{name:/Demo task/}).hasAttribute('disabled')).toBe(true);
});
it('ignores obsolete responses after filter changes and pauses while the page is hidden',async()=>{
 vi.useFakeTimers();let resolveOld:(value:typeof page)=>void=()=>{};
 vi.mocked(api.voiceDirectory).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({...page,total:0,sessions:[]});
 render(<VoiceDirectory onOpenSession={vi.fn()}/>);await expand();fireEvent.change(screen.getByLabelText('组合搜索'),{target:{value:'new'}});await tick();
 await act(async()=>resolveOld(page));expect(screen.queryByText('Demo task')).toBeNull();expect(screen.getByText('没有匹配会话，请调整筛选。')).toBeTruthy();
 const count=vi.mocked(api.voiceDirectory).mock.calls.length;Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'));await tick(30000);expect(api.voiceDirectory).toHaveBeenCalledTimes(count);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});fireEvent(document,new Event('visibilitychange'));await tick();expect(api.voiceDirectory).toHaveBeenCalledTimes(count+1);
});
