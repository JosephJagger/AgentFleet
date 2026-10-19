// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {api} from './lib/api';
import {useCursorPreferences,type CursorPreferences} from './lib/cursor-preferences';
import {CursorControls} from './components/CursorControls';
vi.mock('./lib/api',()=>({api:{cursorPreferences:vi.fn(),saveCursorPreferences:vi.fn(),usage:vi.fn()}}));
const catalog:CursorPreferences={supported:true,observedAt:null,revision:0,settings:{options:{model:'full',effort:'high'}},options:[{id:'model',name:'Model',current:'full',values:[{value:'full',name:'Full'},{value:'small',name:'Small'}]},{id:'effort',name:'Effort',values:[{value:'high',name:'High'}]}],models:[{value:'full',name:'Full',configOptions:[]},{value:'small',name:'Small',configOptions:[]}]};
beforeEach(()=>{vi.resetAllMocks();vi.mocked(api.usage).mockResolvedValue({recorded:null,accounts:[]} as never);});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('refresh and stale responses preserve a successfully saved Cursor model',async()=>{
 vi.useFakeTimers();vi.mocked(api.cursorPreferences).mockResolvedValueOnce(catalog);
 const view=renderHook(({seq})=>useCursorPreferences('s',seq),{initialProps:{seq:1}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
 let stale!:(data:CursorPreferences)=>void;
 vi.mocked(api.cursorPreferences).mockImplementationOnce(()=>new Promise(r=>{stale=r;}));
 view.rerender({seq:2});await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 vi.mocked(api.saveCursorPreferences).mockResolvedValue({...catalog,revision:1,settings:{options:{model:'small'}}});
 await act(async()=>view.result.current.save({options:{model:'small'}}));
 await act(async()=>stale(catalog));
 expect(view.result.current.settings.options?.model).toBe('small');
});
it('changing the Cursor model clears incompatible parameters and requires explicit save',async()=>{
 const onSave=vi.fn().mockResolvedValue(undefined);
 render(<CursorControls sessionId="s" {...catalog} settings={catalog.settings!} ready error="" disabled={false} visible onReload={()=>{}} onSave={onSave}/>);
 fireEvent.change(screen.getByLabelText('Cursor 模型'),{target:{value:'small'}});
 expect(screen.queryByLabelText('Effort')).toBeNull();
 expect(onSave).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Cursor 会话权限'),{target:{value:'always'}});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(onSave).toHaveBeenCalledWith({options:{model:'small'},permissionMode:'always'}));
 await waitFor(()=>expect(screen.getByText(/当前 Cursor ACP 未提供账号额度查询/)).toBeTruthy());
 expect(screen.getByText(/已记录消耗.*原生未上报/)).toBeTruthy();
});
it('old hosts show the upgrade condition and cannot save configuration',()=>{
 render(<CursorControls sessionId="s" {...catalog} supported={false} settings={{}} ready error="" disabled={false} visible={false} onReload={()=>{}} onSave={vi.fn()}/>);
 expect((screen.getByLabelText('Cursor 模型') as HTMLSelectElement).disabled).toBe(true);
 expect(api.usage).not.toHaveBeenCalled();
});
