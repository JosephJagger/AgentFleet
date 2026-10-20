// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {GrokNativePanel} from './components/GrokNativePanel';
import {InlineMedia} from './components/InlineMedia';
import {api} from './lib/api';
import type {FleetSession,CommandReceipt} from './lib/types';
vi.mock('./lib/api',()=>({api:{command:vi.fn()}}));
const session={id:'s',nativeThreadId:'acp_grok_native',executionSegmentId:'segment',threadControlVersion:4,projectLeaseVersion:2,activeTurnId:null} as FleetSession;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.command).mockResolvedValue({command:{id:'cmd'} as CommandReceipt});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('native task entries only compose editable text and never dispatch work',()=>{
 const compose=vi.fn();
 render(<GrokNativePanel session={session} commands={[]} supported onChanged={()=>{}} onCompose={compose}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));fireEvent.click(screen.getByText('原生任务入口'));
 fireEvent.click(screen.getByRole('button',{name:'生成视频'}));
 expect(compose).toHaveBeenCalledWith('请生成视频。内容、时长、画幅与参考素材：');
 expect(api.command).not.toHaveBeenCalled();
});
it('native reads are explicit and destructive commands require confirmation with exact identity',async()=>{
 render(<GrokNativePanel session={session} commands={[]} supported onChanged={()=>{}}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));
 expect(api.command).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('操作'),{target:{value:'rewind.execute'}});
 fireEvent.change(screen.getByLabelText('检查点序号'),{target:{value:'2'}});
 expect((screen.getByRole('button',{name:'执行'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.click(screen.getByRole('button',{name:'执行'}));
 await waitFor(()=>expect(api.command).toHaveBeenCalledOnce());
 expect(api.command).toHaveBeenCalledWith('s',expect.objectContaining({type:'grok.manage',payload:{operation:'rewind.execute',arguments:{targetPromptIndex:2,mode:'conversation_only'},confirmed:true},precondition:{nativeThreadId:'acp_grok_native',executionSegmentId:'segment',threadControlVersion:4,projectLeaseVersion:2,expectedActiveTurnId:null}}));
});
it('a pending or unknown native operation is not automatically replayed',()=>{
 render(<GrokNativePanel session={session} commands={[{type:'grok.manage',state:'unknown'} as CommandReceipt]} supported onChanged={()=>{}}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));
 expect((screen.getByRole('button',{name:'正在处理…'}) as HTMLButtonElement).disabled).toBe(true);expect(api.command).not.toHaveBeenCalled();
});
it('media fetch requires a click and only approved media MIME can be embedded',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,headers:new Headers({'content-type':'text/html'}),blob:vi.fn()});vi.stubGlobal('fetch',fetch);
 render(<InlineMedia url='/api/settings/video-storage/preview?source=test' label='video'/>);
 expect(fetch).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button'));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('此格式不支持内联预览'));
 expect(fetch).toHaveBeenCalledWith('/api/settings/video-storage/preview?source=test',expect.objectContaining({credentials:'same-origin',signal:expect.any(AbortSignal)}));expect(document.querySelector('video')).toBeNull();
});
it('media URLs are revoked when the preview is removed',async()=>{
 const create=vi.fn(()=> 'blob:test-media'),revoke=vi.fn();URL.createObjectURL=create;URL.revokeObjectURL=revoke;
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers({'content-type':'video/mp4'}),blob:async()=>new Blob(['test'])}));
 const view=render(<InlineMedia url='/api/file' label='video'/>);fireEvent.click(screen.getByRole('button'));
 await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toBe('blob:test-media'));expect(document.querySelector('video')?.autoplay).toBe(false);
 view.unmount();expect(revoke).toHaveBeenCalledWith('blob:test-media');
});
