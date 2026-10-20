// @vitest-environment jsdom
import {useState} from 'react';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {claudeComposerCommands,grokComposerCommands,cursorComposerCommands,type ComposerCommand} from './lib/composer-commands';
import {CodexSettingsPanel} from './components/CodexSettingsPanel';
import {useClaudePreferences} from './lib/claude-preferences';
import {api} from './lib/api';
import type {CodexPreferences} from './lib/codex-settings';
vi.mock('./lib/api',()=>({api:{codexPreferences:vi.fn(),saveRuntimePreferences:vi.fn(),claudePreferences:vi.fn(),saveClaudePreferences:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('Claude aliases use only advertised models; changing model clears incompatible effort and auto approval',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 const cmds=claudeComposerCommands({settings:{model:'claude-old',effort:'max',permissionMode:'auto',mode:'plan'},models:[{model:'claude-sonnet-test',displayName:'Sonnet',efforts:['low','high'],supportsAutoMode:false}],permissionModes:['default','auto','acceptEdits'],ready:true,supported:true,save});
 expect(cmds[0].choices?.find(v=>v.value==='claude-sonnet-test')?.aliases).toEqual(['sonnet']);
 expect(cmds.find(c=>c.name==='permissions')?.choices?.map(c=>c.value)).not.toContain('auto');
 await cmds[0].apply!('claude-sonnet-test');
 expect(save).toHaveBeenCalledWith({model:'claude-sonnet-test',effort:undefined,permissionMode:'default',mode:'plan'});
});
it('Grok shortcut preserves startup/search options, clears incompatible model options, and shares native option IDs',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 const settings={model:'old',effort:'high',mode:'plan' as const,permissionMode:'auto' as const,contextWindow:500000,systemPromptOverride:'keep'};
 const cmds=grokComposerCommands({settings,models:[{id:'new',name:'New model',efforts:['low'],contextWindows:[256000]}],options:[{id:'model',name:'Model',current:'old',values:['old','new']}],ready:true,save});
 await cmds[0].apply!('new');expect(save).toHaveBeenCalledWith({...settings,model:'new',effort:undefined,contextWindow:undefined});
 expect(cmds.find(c=>c.name==='permissions')?.choices?.find(c=>c.value==='auto')?.confirmation).toBeTruthy();
});
it('Cursor only exposes native model-specific options and preserves task mode on model changes',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 const cmds=cursorComposerCommands({settings:{options:{model:'new',mode:'plan',effort:'high'},permissionMode:'always'},options:[{id:'model',name:'Model',current:'old',values:[{value:'old',name:'Old'},{value:'new',name:'New'}]},{id:'effort',name:'Effort',values:[{value:'low',name:'Low'}]}],models:[{value:'new',name:'New',configOptions:[{id:'effort',name:'Effort',values:[{value:'high',name:'High'}]}]}],ready:true,supported:true,save});
 expect(cmds.find(c=>c.name==='effort')?.choices?.map(c=>c.value)).toEqual(['host','high']);
 await cmds.find(c=>c.name==='model')!.apply!('old');expect(save).toHaveBeenCalledWith({options:{model:'old',mode:'plan'},permissionMode:'always'});
});
const preferences:CodexPreferences={catalog:{models:[{model:'test-model',displayName:'Test model',efforts:['low','high'],defaultEffort:'low',serviceTiers:[{id:'fast',name:'Fast'}]}],modes:['default','plan'],fetchedAt:'2026-10-20'},preferences:{machine:{settings:null,revision:0},project:{settings:null,revision:0},session:{settings:null,overrides:{model:'test-model',effort:'low',summary:'concise',disabledPluginIds:['keep']},revision:7}},desired:{model:'test-model',effort:'low'},source:'session',effective:{model:'test-model',effort:'low'}};
function CodexHarness(){const [value,setValue]=useState<{sessionId:string;commands:ComposerCommand[]}>();return <><CodexSettingsPanel sessionId="s" onCommands={setValue}/><button disabled={!value||!!value.commands.find(c=>c.name==='effort')?.unavailable} onClick={()=>void value?.commands.find(c=>c.name==='effort')?.apply?.('high')}>Quick high</button><output>{value?.commands.find(c=>c.name==='effort')?.unavailable}</output></>;}
it('Codex quick save uses session revision, retains unrelated overrides and updates the detailed form',async()=>{
 vi.mocked(api.codexPreferences).mockResolvedValue(preferences);
 vi.mocked(api.saveRuntimePreferences).mockImplementation(async(_scope,_id,body)=>({...preferences,preferences:{...preferences.preferences,session:{settings:null,overrides:body.overrides,revision:8}},desired:{model:'test-model',effort:'high'}}));
 render(<CodexHarness/>);await screen.findByRole('combobox',{name:'推理强度'});
 await waitFor(()=>expect((screen.getByText('Quick high') as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByText('Quick high'));
 await waitFor(()=>expect(api.saveRuntimePreferences).toHaveBeenCalledOnce());
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'推理强度'}) as HTMLSelectElement).value).toBe('high'));
 expect(api.saveRuntimePreferences).toHaveBeenCalledWith('session','s',{scope:'session',revision:7,overrides:{model:'test-model',effort:'high',summary:'concise',disabledPluginIds:['keep']}});
 fireEvent.change(screen.getByRole('combobox',{name:'推理强度'}),{target:{value:'low'}});
 expect(screen.getByText('请先保存或取消会话配置中的修改')).toBeTruthy();
});
it('a late Claude save from an old session cannot corrupt the new session revision',async()=>{
 vi.mocked(api.claudePreferences).mockImplementation(async id=>({settings:{model:id},revision:id==='A'?2:9}));
 let finish!:(value:{settings:{model:string};revision:number})=>void;
 vi.mocked(api.saveClaudePreferences).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockImplementation(async(_id,body)=>({settings:body.settings,revision:body.revision+1}));
 const hook=renderHook(({id})=>useClaudePreferences(id),{initialProps:{id:'A'}});
 await waitFor(()=>expect(hook.result.current.ready).toBe(true));let pending!:Promise<void>;
 act(()=>{pending=hook.result.current.save({model:'A-new'});});await waitFor(()=>expect(finish).toBeTruthy());
 hook.rerender({id:'B'});await waitFor(()=>expect(hook.result.current.settings.model).toBe('B'));
 await act(async()=>{finish({settings:{model:'A-new'},revision:3});await pending;});
 await act(async()=>hook.result.current.save({model:'B-new'}));
 expect(api.saveClaudePreferences).toHaveBeenLastCalledWith('B',{settings:{model:'B-new'},revision:9});
});

it('Cursor reserved configuration commands stay blocked when native options are unavailable',()=>{
 const save=vi.fn();const commands=cursorComposerCommands({settings:{},options:[],models:[],ready:true,supported:true,save});
 for(const name of ['model','effort','plan','fast']){const command=commands.find(c=>c.name===name)!;expect(command.choices).toEqual([]);expect(command.unavailable).toBeTruthy();expect(command.apply).toBeUndefined();}
});
