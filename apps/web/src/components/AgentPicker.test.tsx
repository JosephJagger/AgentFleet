// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentPicker} from './AgentPicker';
import {ACP_PROVIDER_IDS,unavailableCapabilities} from '../lib/provider-catalog';
afterEach(cleanup);
it('offers the five new providers only when ready and excludes deferred providers',()=>{
 const onChange=vi.fn();const runtimes=Object.fromEntries(ACP_PROVIDER_IDS.map(id=>[id,{installed:true,version:'fixture',state:id==='qwen'?'ready':'unverified',checkedAt:new Date().toISOString(),capabilities:unavailableCapabilities()}]));
 render(<AgentPicker value="codex" claudeInstalled={true} runtimes={runtimes} onChange={onChange}/>);
 fireEvent.click(screen.getByRole('button',{name:'选择 Agent'}));
 expect(screen.getAllByRole('menuitemradio').map(el=>el.querySelector('strong')?.textContent)).toEqual(['Codex','Claude Code','Cursor','Qwen Code','Kimi Code','CodeBuddy Code','Grok Build']);
 expect((screen.getByRole('menuitemradio',{name:/Kimi Code/}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByText(/Copilot|Antigravity|Gemini|TRAE/)).toBeNull();
 fireEvent.click(screen.getByRole('menuitemradio',{name:/Qwen Code/}));expect(onChange).toHaveBeenCalledWith('qwen');
});
it('renders the selected native identity without relabeling it as Claude',()=>{
 render(<AgentPicker value="grok" claudeInstalled={true} onChange={()=>{}}/>);expect(screen.getByText('Grok Build')).toBeTruthy();expect(screen.queryByText('Claude Code')).toBeNull();
});

it('keeps internal scroll and scrollbar interaction open, but closes outside the menu',()=>{
 render(<AgentPicker value="codex" claudeInstalled onChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'选择 Agent'}));
 const menu=screen.getByRole('menu');
 fireEvent.pointerDown(menu);fireEvent.scroll(menu);
 fireEvent.scroll(screen.getByRole('menuitemradio',{name:/Claude Code/}));
 expect(screen.getByRole('menu')).toBe(menu);
 fireEvent.pointerDown(document.body);expect(screen.queryByRole('menu')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'选择 Agent'}));fireEvent.scroll(window);
 expect(screen.queryByRole('menu')).toBeNull();
});
