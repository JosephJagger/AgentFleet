// @vitest-environment jsdom
import {useEffect} from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {hostSessionGroups,preferredHostSession,rememberHostSession,rememberedHostSession} from './lib/host-session-selection';
import {BuzhoushanSessions} from './components/BuzhoushanSessions';
import {setTheme} from './lib/theme';
import type {FleetSession,Machine} from './lib/types';
vi.mock('./lib/api',()=>({api:{sessionProgress:vi.fn()}}));
const machine={id:'host',reachability:'live'} as Machine;
const session=(id:string,running=false):FleetSession=>({id,machineId:'host',title:id,projectAlias:'Project',nativeThreadId:id,lastActivityAt:'2026-01-01',activeTurnId:running?'turn-'+id:undefined,state:{ownership:'agentfleet_owned',currentTurn:running?'in_progress':'none',reachability:'live',unknownFreeze:false,waitReason:'none'}} as FleetSession);
afterEach(()=>{cleanup();sessionStorage.clear();setTheme('daylight');vi.unstubAllGlobals();});
it('selects one running session, remembers among several, never falls back to an idle or foreign session',()=>{
 const a=session('a',true),b=session('b',true),idle=session('idle');
 expect(preferredHostSession(hostSessionGroups([a,idle],machine),'idle')).toBe('a');
 const groups=hostSessionGroups([a,b,idle,{...a,machineId:'other'}],machine);
 expect(groups.running.map(s=>s.id)).toEqual(['a','b']);expect(groups.managed.map(s=>s.id)).toEqual(['idle']);
 expect(preferredHostSession(groups,'b')).toBe('b');expect(preferredHostSession(groups,'idle')).toBeUndefined();expect(preferredHostSession(groups,'deleted')).toBeUndefined();
 expect(preferredHostSession(hostSessionGroups([idle],machine),'idle')).toBe('idle');
 expect(preferredHostSession(hostSessionGroups([idle],machine))).toBeUndefined();
});
it('excludes unmanaged idle and drafts; marks offline/frozen tasks as managed instead of claiming they run',()=>{
 const a=session('a',true);
 expect(hostSessionGroups([a],{...machine,reachability:'unreachable'}).running).toEqual([]);
 const frozen={...a,state:{...a.state,unknownFreeze:true}};
 expect(hostSessionGroups([frozen],machine).managed).toEqual([frozen]);
 expect(hostSessionGroups([{...a,activeTurnId:undefined,nativeThreadId:undefined,state:{...a.state,currentTurn:'none'}},{...session('x'),state:{...a.state,currentTurn:'none',ownership:'claimable'}}],machine).managed).toEqual([]);
});
it('keeps per-host browser memory isolated by owner and rejects invalid storage',()=>{
 rememberHostSession('owner-a','host','a');rememberHostSession('owner-a','other','b');
 expect(rememberedHostSession('owner-a','host')).toBe('a');expect(rememberedHostSession('owner-a','other')).toBe('b');expect(rememberedHostSession('owner-b','host')).toBeUndefined();
 sessionStorage.setItem('agentfleet.host-session:owner-a','bad json');expect(rememberedHostSession('owner-a','host')).toBeUndefined();
});
it('renders two compact rows, masks names and moves completed sessions without navigating',()=>{
 setTheme('buzhoushan');vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const onSelect=vi.fn(),a=session('a',true);a.title='CUPSHE work';a.projectAlias='gongqiankun';
 const props={enabled:true,machine,sessions:[a,session('idle')],selectedId:'a',onSelect,onBrowse:vi.fn(),onCreate:vi.fn(),children:<div>Selected conversation</div>};
 const view=render(<BuzhoushanSessions {...props}/>);
 expect(within(screen.getByRole('region',{name:'正在运行'})).getByText('c****e work',{exact:false})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/c\*\*\*\*e work/}));expect(onSelect).toHaveBeenCalledWith('a');onSelect.mockClear();
 view.rerender(<BuzhoushanSessions {...props} sessions={[{...a,activeTurnId:undefined,state:{...a.state,currentTurn:'completed'}},session('idle')]}/>);
 expect(screen.getByText('暂无运行会话')).toBeTruthy();expect(within(screen.getByRole('region',{name:'已接管'})).getByText('c****e work')).toBeTruthy();expect(onSelect).not.toHaveBeenCalled();
 expect(screen.getByText('Selected conversation')).toBeTruthy();expect(screen.queryByText('gongqiankun')).toBeNull();
});
it('shows explicit empty states and browse/create actions; other themes retain only children',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});const browse=vi.fn(),create=vi.fn();
 const props={enabled:true,machine,sessions:[],onSelect:vi.fn(),onBrowse:browse,onCreate:create,children:<div>Conversation</div>};const view=render(<BuzhoushanSessions {...props}/>);
 expect(screen.getByText('暂无运行会话')).toBeTruthy();expect(screen.getByText('暂无已接管会话')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'展开项目与会话'}));expect(browse).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'新会话'}));expect(create).toHaveBeenCalledOnce();
 view.rerender(<BuzhoushanSessions {...props} enabled={false}/>);expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();expect(screen.getByText('Conversation')).toBeTruthy();
});

it('hides the switcher for a sole running session without remounting the conversation',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const mounted=vi.fn(),unmounted=vi.fn();function Conversation(){useEffect(()=>{mounted();return unmounted;},[]);return <div>Stable conversation</div>;}
 const a=session('a',true);const props={enabled:true,machine,sessions:[a],selectedId:'a',onSelect:vi.fn(),onBrowse:vi.fn(),onCreate:vi.fn(),children:<Conversation/>};
 const view=render(<BuzhoushanSessions {...props}/>);
 expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();expect(screen.getByText('Stable conversation')).toBeTruthy();
 for(const sessions of [[a,session('b',true)],[a,session('idle')]]) {
  view.rerender(<BuzhoushanSessions {...props} sessions={sessions}/>);expect(screen.getByLabelText('当前主机会话切换')).toBeTruthy();
  view.rerender(<BuzhoushanSessions {...props}/>);expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();
 }
 expect(mounted).toHaveBeenCalledOnce();expect(unmounted).not.toHaveBeenCalled();
});
