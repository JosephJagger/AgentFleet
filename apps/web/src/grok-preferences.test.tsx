// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {api} from './lib/api';
import {useGrokPreferences,type GrokPreferences} from './lib/grok-preferences';
import {GrokControls} from './components/GrokControls';
vi.mock('./lib/api',()=>({api:{grokPreferences:vi.fn(),saveGrokPreferences:vi.fn()}}));
const catalog:GrokPreferences={revision:0,settings:{},options:[{id:'model',values:['grok-full','grok-small']},{id:'reasoning_effort',values:['low','high']}],models:[{id:'grok-full',name:'Full',efforts:['low','high']},{id:'grok-small',name:'Small',efforts:['low']}]};
beforeEach(()=>{vi.resetAllMocks();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('continuous progress does not abort or starve the first settings read',async()=>{
 let done!:(data:GrokPreferences)=>void;
 vi.mocked(api.grokPreferences).mockImplementation(()=>new Promise(resolve=>{done=resolve;}));
 const view=renderHook(({seq})=>useGrokPreferences('session',seq),{initialProps:{seq:1}});
 await waitFor(()=>expect(api.grokPreferences).toHaveBeenCalledTimes(1));
 const signal=vi.mocked(api.grokPreferences).mock.calls[0]![1]!;
 for(let seq=2;seq<50;seq++)view.rerender({seq});
 expect(signal.aborted).toBe(false);
 await act(async()=>done(catalog));
 expect(view.result.current.ready).toBe(true);
 expect(view.result.current.models).toEqual(catalog.models);
});
it('an older background response cannot overwrite a successfully saved model',async()=>{
 vi.useFakeTimers();vi.mocked(api.grokPreferences).mockResolvedValueOnce(catalog);
 const view=renderHook(({seq})=>useGrokPreferences('session',seq),{initialProps:{seq:1}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
 let stale!:(data:GrokPreferences)=>void;
 vi.mocked(api.grokPreferences).mockImplementationOnce(()=>new Promise(resolve=>{stale=resolve;}));
 view.rerender({seq:2});
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 vi.mocked(api.saveGrokPreferences).mockResolvedValue({...catalog,revision:1,settings:{model:'grok-full'}});
 await act(async()=>view.result.current.save({model:'grok-full'}));
 await act(async()=>stale(catalog));
 expect(view.result.current.settings.model).toBe('grok-full');
});
it('native model choices are usable before a first turn; incompatible effort is cleared on model change',async()=>{
 const onSave=vi.fn().mockResolvedValue(undefined);
 render(<GrokControls options={catalog.options} models={catalog.models} settings={{model:'grok-full',effort:'high'}} ready error="" onReload={()=>{}} onSave={onSave} disabled={false}/>);
 expect(screen.getByRole('button',{name:'Grok Build 设置'}).textContent).toContain('grok-full · high · 逐项确认');
 expect(screen.getByRole('button',{name:'Grok Build 设置'}).textContent).not.toContain('Grok Build ·');
 fireEvent.click(screen.getByRole('button',{name:'Grok Build 设置'}));
 const select=screen.getByLabelText('Grok Build 模型') as HTMLSelectElement;
 expect(select.disabled).toBe(false);
 expect(Array.from(select.options).map(o=>o.text)).toEqual(['沿用原生','Full','Small']);
 fireEvent.change(select,{target:{value:'grok-small'}});
 expect((screen.getByLabelText('Grok Build 思考强度') as HTMLSelectElement).value).toBe('');
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(onSave).toHaveBeenCalledWith({model:'grok-small',effort:undefined}));
});
