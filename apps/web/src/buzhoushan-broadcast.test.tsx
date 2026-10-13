// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
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
