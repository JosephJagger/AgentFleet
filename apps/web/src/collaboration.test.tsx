// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CollaborationWorkspace,SharedBrowser,TaskBoard} from './components/CollaborationWorkspace';
import {api,collaborationApi} from './lib/api';
import type {FleetSession} from './lib/types';
import type {BrowserFrame,CollaborationPlan} from './lib/collaboration';
vi.mock('./lib/api',()=>({api:{sessions:vi.fn()},collaborationApi:{browser:vi.fn(),plans:vi.fn(),create:vi.fn(),action:vi.fn()}}));
const session={id:'s',title:'Research',machineName:'Fixture Mac',state:{ownership:'agentfleet_owned'}} as FleetSession;
const frame:BrowserFrame={mode:'human',revision:1,url:'about:blank',title:'',image:'data:image/jpeg;base64,AA==',width:1280,height:800,pending:null,busy:false};
const plan:CollaborationPlan={id:'plan',sessionId:'s',title:'Launch research',state:'running',createdAt:'2026-10-12',tasks:[{title:'Research',prompt:'Read only',sessionId:'s',dependsOn:[],state:'unknown',result:'',commandId:'cmd'}]};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.sessions).mockResolvedValue({items:[{...session,provider:'codex'}],nextCursor:null});vi.mocked(collaborationApi.plans).mockResolvedValue({plans:[]});vi.mocked(collaborationApi.browser).mockResolvedValue(frame);});
afterEach(cleanup);
it('opens browser only after explicit click and identifies its real host',async()=>{
 render(<SharedBrowser session={session}/>);expect(screen.getByText('Fixture Mac')).toBeTruthy();expect(collaborationApi.browser).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'打开浏览器协作'}));await screen.findByText('由你操作');
 expect(collaborationApi.browser).toHaveBeenCalledWith('s',expect.objectContaining({action:'open'}));
 fireEvent.click(screen.getByRole('button',{name:'交给 AI'}));await waitFor(()=>expect(collaborationApi.browser).toHaveBeenCalledWith('s',expect.objectContaining({action:'handoff',revision:1})));
});
it('pending AI action is shown and never approved automatically',async()=>{
 vi.mocked(collaborationApi.browser).mockResolvedValue({...frame,mode:'agent',revision:3,pending:{id:'pending',action:{action:'navigate',url:'https://example.test'}}});
 render(<SharedBrowser session={session}/>);fireEvent.click(screen.getByRole('button',{name:'打开浏览器协作'}));await screen.findByText('AI 想执行这一步，请你确认');
 expect(vi.mocked(collaborationApi.browser).mock.calls.some(c=>c[1].action==='approve')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'拒绝'}));await waitFor(()=>expect(collaborationApi.browser).toHaveBeenCalledWith('s',expect.objectContaining({action:'deny',pendingId:'pending',revision:3})));
});
it('recovering a plan is read only and unknown outcomes have no retry button',async()=>{
 vi.mocked(collaborationApi.plans).mockResolvedValue({plans:[plan]});render(<TaskBoard session={session}/>);await screen.findByText('结果待核实');
 expect(collaborationApi.create).not.toHaveBeenCalled();expect(collaborationApi.action).not.toHaveBeenCalled();expect(screen.queryByText('重试')).toBeNull();
 vi.mocked(collaborationApi.action).mockResolvedValue({...plan,state:'paused'});fireEvent.click(screen.getByRole('button',{name:'暂停后续派发'}));
 await waitFor(()=>expect(collaborationApi.action).toHaveBeenCalledWith('plan','pause'));
});
it('closing workspace only collapses UI, never cancels tasks or calls',()=>{
 const close=vi.fn();render(<CollaborationWorkspace session={session} tab="browser" onTab={vi.fn()} onClose={close}/>);
 fireEvent.click(screen.getByRole('button',{name:'收起协作工作区'}));expect(close).toHaveBeenCalledOnce();expect(collaborationApi.action).not.toHaveBeenCalled();expect(collaborationApi.browser).not.toHaveBeenCalled();
});

it('AI drafts require explicit review and confirmation; malformed dependency graphs are rejected',async()=>{
 const {readPlanDraft}=await import('./lib/collaboration');
 expect(readPlanDraft('```json\n{"tasks":[{"title":"Research","prompt":"Read sources","sessionId":"s","dependsOn":[]}]}\n```')).toHaveLength(1);
 expect(()=>readPlanDraft('{"tasks":[{"title":"Research","prompt":"Read","sessionId":"s","dependsOn":[0]}]}')).toThrow();
 const draft={...plan,state:'completed',tasks:[{...plan.tasks[0],state:'completed',planning:true,result:'{"tasks":[{"title":"Read sources","prompt":"Only report facts","sessionId":"s","dependsOn":[]}]}'}]};
 vi.mocked(collaborationApi.plans).mockResolvedValue({plans:[draft]});
 render(<TaskBoard session={session}/>);fireEvent.click(await screen.findByRole('button',{name:'审阅这份分工草稿'}));
 expect(await screen.findByDisplayValue('Read sources')).toBeTruthy();expect(collaborationApi.create).not.toHaveBeenCalled();
 await waitFor(()=>expect(screen.getByRole('option',{name:/Fixture Mac/})).toBeTruthy());
 vi.mocked(collaborationApi.create).mockResolvedValue(plan);
 fireEvent.click(screen.getByRole('button',{name:'确认分工并开始'}));
 await waitFor(()=>expect(collaborationApi.create).toHaveBeenCalledWith(expect.objectContaining({confirmed:true,tasks:[{title:'Read sources',prompt:'Only report facts',sessionId:'s',dependsOn:[]}]})));
});
