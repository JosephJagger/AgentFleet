// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {BuzhoushanBroadcastControl} from './components/BuzhoushanBroadcast';
vi.mock('./i18n',()=>({t:(value:string)=>value}));
afterEach(()=>{cleanup();localStorage.clear();});
it('shows intro only while the canvas is enabled and portals it outside the clipped workspace',()=>{
 const {container,rerender}=render(<BuzhoushanBroadcastControl enabled={false} onChange={()=>{}}/>);
 expect(screen.queryByLabelText('直播间介绍')).toBeNull();
 rerender(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 expect(screen.getByRole('heading',{name:'AI 编程实战'})).toBeTruthy();
 expect(container.contains(screen.getByLabelText('直播间介绍'))).toBe(false);
 rerender(<BuzhoushanBroadcastControl enabled={false} onChange={()=>{}}/>);
 expect(screen.queryByLabelText('直播间介绍')).toBeNull();
});
it('edits plain text locally and restores it on the next mount',()=>{
 const view=render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'直播采集设置'}));
 fireEvent.change(screen.getByLabelText('左侧标题'),{target:{value:'今晚一起调试'}});
 expect(screen.getByRole('heading',{name:'今晚一起调试'})).toBeTruthy();
 view.unmount();render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 expect(screen.getByRole('heading',{name:'今晚一起调试'})).toBeTruthy();
});
it('recovers from malformed saved preferences',()=>{
 localStorage.setItem('agentfleet:buzhoushan-broadcast-intro','invalid');
 render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 expect(screen.getByText((_,element)=>element?.tagName==='P'&&element.textContent==='Codex · Claude Code')).toBeTruthy();
});
it('opens a separate capture window without reusing the current call window and reports popup blocking',()=>{
 const open=vi.spyOn(window,'open').mockReturnValue(null);
 render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'直播采集设置'}));
 const button=screen.getByRole('button',{name:'打开 16:9 直播窗口'});
 fireEvent.click(button);fireEvent.click(button);
 expect(screen.getByRole('status').textContent).toContain('窗口未打开');
 expect(open.mock.calls[0][0]).toBe('/workbench?broadcast=1');
 expect(open.mock.calls[0][1]).not.toBe(open.mock.calls[1][1]);
 open.mockRestore();
});
it('never resizes the original window and fits only the dedicated popup once',()=>{
 const resize=vi.spyOn(window,'resizeTo').mockImplementation(()=>{});
 const originalName=window.name;
 const view=render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 expect(resize).not.toHaveBeenCalled();view.unmount();
 window.name='agentfleet-broadcast-canvas-test';
 const popup=render(<BuzhoushanBroadcastControl enabled onChange={()=>{}}/>);
 expect(resize).toHaveBeenCalledTimes(1);
 popup.rerender(<BuzhoushanBroadcastControl enabled={false} onChange={()=>{}}/>);
 expect(resize).toHaveBeenCalledTimes(1);
 window.name=originalName;resize.mockRestore();
});

it('one screensaver button raises the screensaver at once, with or without a call',async()=>{
 const idle=await import('./lib/buzhoushan-idle');
 const raise=vi.spyOn(idle,'requestScreensaver');
 const {voiceStatus}=await import('./lib/voice-status');
 const view=render(<BuzhoushanBroadcastControl enabled={false} onChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'屏保'}));
 expect(raise).toHaveBeenCalledTimes(1);
 act(()=>{voiceStatus.publish('x',{phase:'connecting',muted:false,kind:'global'});voiceStatus.publish('x',{phase:'connected',muted:false,kind:'global'});});
 expect(screen.getByRole('button',{name:'屏保'})).toBeTruthy();            // same name during a call: there is only one screensaver
 expect(screen.queryByRole('button',{name:'屏保测试'})).toBeNull();expect(screen.queryByRole('button',{name:'声纹屏保'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'屏保'}));
 expect(raise).toHaveBeenCalledTimes(2);
 act(()=>{voiceStatus.release('x');});view.unmount();raise.mockRestore();
});
