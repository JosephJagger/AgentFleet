// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {api} from './lib/api';
import {useCursorPreferences,type CursorPreferences} from './lib/cursor-preferences';
import {setLocale} from './i18n';
import {CursorSettingsShortcut} from './components/CursorSettingsShortcut';
import {cursorSettingsSummary} from './lib/cursor-labels';
import {CursorControls} from './components/CursorControls';
vi.mock('./lib/api',()=>({api:{cursorPreferences:vi.fn(),saveCursorPreferences:vi.fn(),usage:vi.fn()}}));
const catalog:CursorPreferences={supported:true,observedAt:null,revision:0,settings:{options:{model:'full',effort:'high'}},options:[{id:'model',name:'Model',current:'full',values:[{value:'full',name:'Full'},{value:'small',name:'Small'}]},{id:'effort',name:'Effort',values:[{value:'high',name:'High'}]}],models:[{value:'full',name:'Full',configOptions:[]},{value:'small',name:'Small',configOptions:[]}]};
beforeEach(()=>{setLocale('zh-CN');vi.resetAllMocks();vi.mocked(api.usage).mockResolvedValue({recorded:null,accounts:[]} as never);});
afterEach(()=>{cleanup();setLocale('zh-CN');vi.useRealTimers();});
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
 expect(screen.queryByLabelText('Cursor 思考强度')).toBeNull();
 expect(onSave).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Cursor 会话权限'),{target:{value:'always'}});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(onSave).toHaveBeenCalledWith({options:{model:'small'},permissionMode:'always'}));
 await waitFor(()=>expect(screen.getByText(/未读取到 Cursor 账号额度/)).toBeTruthy());
 expect(screen.getByText(/已记录消耗.*原生未上报/)).toBeTruthy();
});
it('old hosts show the upgrade condition and cannot save configuration',()=>{
 render(<CursorControls sessionId="s" {...catalog} supported={false} settings={{}} ready error="" disabled={false} visible={false} onReload={()=>{}} onSave={vi.fn()}/>);
 expect((screen.getByLabelText('Cursor 模型') as HTMLSelectElement).disabled).toBe(true);
 expect(api.usage).not.toHaveBeenCalled();
});
it('shows Cursor account quota from its own account service without any Grok association',async()=>{
 const at=new Date().toISOString();
 vi.mocked(api.usage).mockResolvedValue({recorded:null,last:null,accounts:[{sourceMachine:'B52H',identityKnown:false,subscriptionType:'Super',observedAt:at,stale:false,windows:[{bucket:'cursor',window:'primary',usedPercent:4.598056810446191,remainingPercent:95.4019431895538,windowMinutes:10080,resetsAt:Math.floor(Date.now()/1000)+86400}]}]} as never);
 render(<CursorControls sessionId="s" {...catalog} settings={{}} ready error="" disabled={false} visible onReload={()=>{}} onSave={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByText('已用 4.6% · 剩余 95.4%')).toBeTruthy());
 expect(screen.getByText(/Super · 账号额度/)).toBeTruthy();
 expect(screen.getByText(/已记录消耗.*原生未上报/)).toBeTruthy();
 expect(screen.queryByText(/Grok/)).toBeNull();
 expect(api.usage).toHaveBeenCalledWith('session','s',expect.any(AbortSignal),'cursor');
});
it('marks stale Cursor quota and explains a missing one',async()=>{
 const at=new Date(Date.now()-600000).toISOString();
 vi.mocked(api.usage).mockResolvedValue({recorded:null,last:null,accounts:[{sourceMachine:'B52H',identityKnown:false,observedAt:at,stale:true,windows:[{bucket:'cursor',window:'primary',usedPercent:4,remainingPercent:96,windowMinutes:10080,resetsAt:Math.floor(Date.now()/1000)+86400}]}]} as never);
 const view=render(<CursorControls sessionId="s" {...catalog} settings={{}} ready error="" disabled={false} visible onReload={()=>{}} onSave={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByText(/数据已过期/)).toBeTruthy());
 view.unmount();
 vi.mocked(api.usage).mockResolvedValue({recorded:null,last:null,accounts:[]} as never);
 render(<CursorControls sessionId="s" {...catalog} settings={{}} ready error="" disabled={false} visible onReload={()=>{}} onSave={vi.fn()}/>);
 await waitFor(()=>expect(screen.getByText(/未读取到 Cursor 账号额度/)).toBeTruthy());
});

it('localizes native Cursor controls while saving their exact native values',async()=>{
 const onSave=vi.fn().mockResolvedValue(undefined);
 const options=[...catalog.options,{id:'fast',name:'Fast',current:'fast',values:[{value:'fast',name:'Fast'},{value:'normal',name:'Normal'}]}];
 const props={sessionId:'s',...catalog,options,settings:catalog.settings!,ready:true,error:'',disabled:false,visible:false,onReload:()=>{},onSave};
 const view=render(<CursorControls {...props}/>);
 expect(screen.getByLabelText('Cursor 思考强度')).toBeTruthy();
 expect(screen.getByRole('option',{name:'High'})).toBeTruthy();
 expect(screen.getByLabelText('Cursor 快速模式')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Cursor 快速模式'),{target:{value:'normal'}});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(onSave).toHaveBeenCalledWith({options:{model:'full',effort:'high',fast:'normal'}}));
 setLocale('en');view.rerender(<CursorControls {...props}/>);
 expect(screen.getByLabelText('Cursor Effort')).toBeTruthy();
 expect(screen.getByLabelText('Cursor Fast mode')).toBeTruthy();
 expect(screen.getByRole('option',{name:'High'})).toBeTruthy();
 expect(screen.queryByText('思考强度')).toBeNull();
});
it('shows a Grok-style saved configuration shortcut and opens configuration without submitting',()=>{
 const onOpen=vi.fn();
 const props={...catalog,settings:{options:{model:'full',effort:'high'},permissionMode:'always' as const},ready:true,error:'',onOpen};
 const view=render(<form onSubmit={()=>{throw Error('must not submit');}}><CursorSettingsShortcut {...props}/></form>);
 expect(screen.getByText('发送使用')).toBeTruthy();
 expect(screen.getByText('Full · High · 始终允许')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Cursor 会话配置'}));expect(onOpen).toHaveBeenCalledOnce();
 setLocale('en');view.rerender(<CursorSettingsShortcut {...props}/>);
 expect(screen.getByText('Send with')).toBeTruthy();expect(screen.getByText('Full · High · Always allow')).toBeTruthy();
});
it('does not borrow effort from the old model and retains unknown native names',()=>{
 const models=[{value:'small',name:'Small',configOptions:[{id:'effort',name:'Effort',current:'low',values:[{value:'low',name:'Low'}]}]}];
 expect(cursorSettingsSummary({options:{model:'small'}},catalog.options,models)).toBe('Small · Low · 逐项确认');
 expect(cursorSettingsSummary({options:{model:'unknown'}},catalog.options,models)).toBe('unknown · 逐项确认');
});
