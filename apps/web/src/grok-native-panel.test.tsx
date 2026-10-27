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

it('MCP tool controls submit only the explicit names and require confirmation',async()=>{
 render(<GrokNativePanel session={session} commands={[]} supported onChanged={()=>{}}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));
 fireEvent.change(screen.getByLabelText('操作'),{target:{value:'mcp.tool.disable'}});
 fireEvent.change(screen.getByLabelText('MCP 服务器名称'),{target:{value:'search'}});
 fireEvent.change(screen.getByLabelText('MCP 工具名称'),{target:{value:'lookup'}});
 expect((screen.getByRole('button',{name:'执行'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'执行'}));
 await waitFor(()=>expect(api.command).toHaveBeenCalledWith('s',expect.objectContaining({payload:{operation:'mcp.tool.disable',arguments:{serverName:'search',toolName:'lookup'},confirmed:true}})));
});
it('a workflow result fills the composer and does not send',()=>{
 const compose=vi.fn();
 const long='a'.repeat(65);
 const commands=[{id:'wf',type:'grok.manage',grokResult:{operation:'workflows.list',status:'received',rows:[
  {name:'review',status:'',detail:'workflow'},
  {name:'Bad Name',status:'',detail:'space'},
  {name:'Review',status:'',detail:'uppercase'},
  {name:long,status:'',detail:'long'},
 ]}} as CommandReceipt];
 render(<GrokNativePanel session={session} commands={commands} supported onChanged={()=>{}} onCompose={compose}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));
 expect(screen.queryByRole('button',{name:'填入输入框'})).toBeNull();
 fireEvent.change(screen.getByLabelText('操作'),{target:{value:'workflows.list'}});
 expect(screen.getAllByRole('button',{name:'填入输入框'})).toHaveLength(1);
 expect(screen.getByText('Bad Name')).toBeTruthy();
 expect(screen.getByText('Review')).toBeTruthy();
 expect(screen.getByText(long)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'填入输入框'}));
 expect(compose).toHaveBeenCalledOnce();
 expect(compose).toHaveBeenCalledWith('/workflow review');
 expect(api.command).not.toHaveBeenCalled();
});
it('file inspection uses numeric offsets and remains an explicit read',async()=>{
 render(<GrokNativePanel session={session} commands={[]} supported onChanged={()=>{}}/>);
 fireEvent.click(screen.getByText('Grok 原生工具'));fireEvent.change(screen.getByLabelText('操作'),{target:{value:'files.list'}});
 fireEvent.change(screen.getByLabelText('项目内相对文件路径'),{target:{value:'.'}});
 fireEvent.change(screen.getByLabelText('读取起点（目录条目或文件字节）'),{target:{value:'50'}});
 fireEvent.click(screen.getByRole('button',{name:'读取'}));
 await waitFor(()=>expect(api.command).toHaveBeenCalledWith('s',expect.objectContaining({payload:{operation:'files.list',arguments:{filePath:'.',offset:50}}})));
});
