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
 expect(preferredHostSession(hostSessionGroups([idle],machine),'idle')).toBeUndefined();
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
 const props={enabled:true,machine,sessions:[a,session('idle')],onSelect,onBrowse:vi.fn(),onCreate:vi.fn(),children:<div>Selected conversation</div>};
 const view=render(<BuzhoushanSessions {...props}/>);
 expect(within(within(screen.getByRole('region',{name:'Codex'})).getByRole('region',{name:'正在运行'})).getByText('c****e work',{exact:false})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/c\*\*\*\*e work/}));expect(onSelect).toHaveBeenCalledWith('a');onSelect.mockClear();
 view.rerender(<BuzhoushanSessions {...props} sessions={[{...a,activeTurnId:undefined,state:{...a.state,currentTurn:'completed'}},session('idle')]}/>);
 expect(screen.getAllByText('暂无运行会话')[0]).toBeTruthy();expect(within(within(screen.getByRole('region',{name:'Codex'})).getByRole('region',{name:'已接管'})).getByText('c****e work')).toBeTruthy();expect(onSelect).not.toHaveBeenCalled();
 expect(screen.getByText('Selected conversation')).toBeTruthy();expect(screen.queryByText('gongqiankun')).toBeNull();
});
it('shows explicit empty states and browse/create actions; other themes retain only children',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});const browse=vi.fn(),create=vi.fn();
 const props={enabled:true,machine,sessions:[],onSelect:vi.fn(),onBrowse:browse,onCreate:create,children:<div>Conversation</div>};const view=render(<BuzhoushanSessions {...props}/>);
 expect(screen.getAllByText('暂无运行会话')[0]).toBeTruthy();expect(screen.getAllByText('暂无已接管会话')[0]).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'展开项目与会话'}));expect(browse).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'新会话'}));expect(create).toHaveBeenCalledOnce();
 view.rerender(<BuzhoushanSessions {...props} enabled={false}/>);expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();expect(screen.getByText('Conversation')).toBeTruthy();
});

it('hides the switcher for a sole running session without remounting the conversation',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const mounted=vi.fn(),unmounted=vi.fn();function Conversation(){useEffect(()=>{mounted();return unmounted;},[]);return <div>Stable conversation</div>;}
 const a=session('a',true);const props={enabled:true,machine,sessions:[a],selectedId:'a',onSelect:vi.fn(),onBrowse:vi.fn(),onCreate:vi.fn(),children:<Conversation/>};
 const view=render(<BuzhoushanSessions {...props}/>);
 expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();expect(screen.getByText('Stable conversation')).toBeTruthy();
 for(const sessions of [[a,session('b',true)],[a,session('idle')]]) {
  view.rerender(<BuzhoushanSessions {...props} sessions={sessions}/>);expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'切换会话'}));expect(screen.getByLabelText('当前主机会话切换')).toBeTruthy();
  expect(props.onBrowse).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector<HTMLButtonElement>('.buzhou-session-window')!);expect(props.onSelect).toHaveBeenCalledWith('a');
  view.rerender(<BuzhoushanSessions {...props}/>);expect(screen.queryByLabelText('当前主机会话切换')).toBeNull();
 }
 expect(mounted).toHaveBeenCalledOnce();expect(unmounted).not.toHaveBeenCalled();
});

it('clears manual card highlighting after host changes and remount, not dashboard refreshes',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const idle=session('idle');const props={enabled:true,machine,sessions:[idle],selectedId:'idle',onSelect:vi.fn(),onBrowse:vi.fn(),onCreate:vi.fn(),children:<div>Conversation</div>};
 const view=render(<BuzhoushanSessions {...props}/>);
 const open=()=>fireEvent.click(screen.getByRole('button',{name:'切换会话'}));
 const card=()=>document.querySelector<HTMLButtonElement>('.buzhou-session-window')!;
 open();expect(card().getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(card());open();expect(card().getAttribute('aria-pressed')).toBe('true');
 view.rerender(<BuzhoushanSessions {...props} sessions={[{...idle,lastActivityAt:'2026-02-01'}]}/>);expect(card().getAttribute('aria-pressed')).toBe('true');
 view.rerender(<BuzhoushanSessions {...props} machine={{...machine,id:'other'}}/>);
 view.rerender(<BuzhoushanSessions {...props}/>);open();expect(card().getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(card());view.unmount();render(<BuzhoushanSessions {...props}/>);open();expect(card().getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(card());open();expect(card().getAttribute('aria-pressed')).toBe('true');
});

it('always separates Codex and Claude Code, including hosts with no Claude installation',()=>{
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const codex=session('codex-running',true),claude={...session('claude-idle'),provider:'claude' as const};
 const props={enabled:true,machine:{...machine,agentRuntimes:{claude:{installed:false,version:null}}},sessions:[codex,claude],onSelect:vi.fn(),onBrowse:vi.fn(),onCreate:vi.fn(),children:<div/>};
 const view=render(<BuzhoushanSessions {...props}/>);
 const codexGroup=within(screen.getByRole('region',{name:'Codex'})),claudeGroup=within(screen.getByRole('region',{name:'Claude Code'}));
 expect(codexGroup.getByText('codex-running')).toBeTruthy();expect(codexGroup.queryByText('claude-idle')).toBeNull();
 expect(claudeGroup.getByText('claude-idle')).toBeTruthy();expect(claudeGroup.queryByText('codex-running')).toBeNull();expect(claudeGroup.getByText('未安装')).toBeTruthy();
 view.rerender(<BuzhoushanSessions {...props} sessions={[codex]}/>);
 expect(claudeGroup.getByText('暂无运行会话')).toBeTruthy();expect(claudeGroup.getByText('暂无已接管会话')).toBeTruthy();
});
