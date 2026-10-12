// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CollaborationWorkspace,SharedBrowser,TaskBoard} from './components/CollaborationWorkspace';
import {api,collaborationApi} from './lib/api';
import type {FleetSession} from './lib/types';
import type {BrowserFrame,CollaborationPlan} from './lib/collaboration';
vi.mock('./lib/api',()=>({api:{sessions:vi.fn()},collaborationApi:{browser:vi.fn(),browserStatus:vi.fn(),plans:vi.fn(),create:vi.fn(),action:vi.fn()}}));
const session={id:'s',title:'Research',machineName:'Fixture Mac',state:{ownership:'agentfleet_owned'}} as FleetSession;
const frame:BrowserFrame={mode:'human',revision:1,url:'about:blank',title:'',image:'data:image/jpeg;base64,AA==',width:1280,height:800,pending:null,busy:false};
const plan:CollaborationPlan={id:'plan',sessionId:'s',title:'Launch research',state:'running',createdAt:'2026-10-12',tasks:[{title:'Research',prompt:'Read only',sessionId:'s',dependsOn:[],state:'unknown',result:'',commandId:'cmd'}]};
let browserState:'closed'|'open';
beforeEach(()=>{vi.resetAllMocks();browserState='closed';vi.mocked(api.sessions).mockResolvedValue({items:[{...session,provider:'codex'}],nextCursor:null});vi.mocked(collaborationApi.plans).mockResolvedValue({plans:[]});vi.mocked(collaborationApi.browser).mockImplementation(async(_id,request)=>{if(request.action==='open')browserState='open';if(request.action==='close')browserState='closed';return frame;});vi.mocked(collaborationApi.browserStatus).mockImplementation(async()=>({state:browserState}));});
afterEach(()=>{cleanup();vi.useRealTimers();});
const browserActions=()=>vi.mocked(collaborationApi.browser).mock.calls.map(call=>call[1].action);
const timeoutError=()=>Object.assign(new Error('Host request timed out'),{status:504,code:'HOST_REQUEST_TIMEOUT'});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function openingButton(){const button=await screen.findByRole('button',{name:'打开浏览器协作'});await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));return button;}
async function openBrowser(){fireEvent.click(await openingButton());await screen.findByText('由你操作');}
it('opens browser only after explicit click and identifies its real host',async()=>{
 render(<SharedBrowser session={session}/>);expect(screen.getByText('Fixture Mac')).toBeTruthy();expect(collaborationApi.browser).not.toHaveBeenCalled();
 await openBrowser();
 expect(vi.mocked(collaborationApi.browser).mock.calls.some(([id,request])=>id==='s'&&request.action==='open')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'交给 AI'}));await waitFor(()=>expect(vi.mocked(collaborationApi.browser).mock.calls.some(([id,request])=>id==='s'&&request.action==='handoff'&&request.revision===1)).toBe(true));
});
it('pending AI action is shown and never approved automatically',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'closed'}).mockResolvedValue({state:'open'});
 vi.mocked(collaborationApi.browser).mockResolvedValue({...frame,mode:'agent',revision:3,pending:{id:'pending',action:{action:'navigate',url:'https://example.test'}}});
 render(<SharedBrowser session={session}/>);fireEvent.click(await openingButton());await screen.findByText('AI 想执行这一步，请你确认');
 expect(vi.mocked(collaborationApi.browser).mock.calls.some(c=>c[1].action==='approve')).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'拒绝'}));await waitFor(()=>expect(vi.mocked(collaborationApi.browser).mock.calls.some(([id,request])=>id==='s'&&request.action==='deny'&&request.pendingId==='pending'&&request.revision===3)).toBe(true));
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

it('restores an already open browser from status without opening or handing it off',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'open'});
 render(<SharedBrowser session={session}/>);
 await screen.findByAltText('所选主机上的实时网页预览');
 expect(vi.mocked(collaborationApi.browserStatus).mock.calls[0]?.[0]).toBe('s');
 expect(browserActions()).toEqual(['snapshot']);
 expect(screen.queryByRole('button',{name:'打开浏览器协作'})).toBeNull();
 expect(screen.getByText('由你操作')).toBeTruthy();
});

it('checking a closed browser never starts one automatically',async()=>{
 render(<SharedBrowser session={session}/>);
 await screen.findByRole('button',{name:'打开浏览器协作'});
 expect(collaborationApi.browserStatus).toHaveBeenCalled();
 expect(collaborationApi.browser).not.toHaveBeenCalled();
});

it('a failed status query stays unknown and recheck only reads status',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({state:'closed'});
 render(<SharedBrowser session={session}/>);
 await screen.findByText('浏览器状态暂未确认');
 expect((screen.getByRole('button',{name:'打开浏览器协作'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText('Connection lost')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'重新检查'}));
 await screen.findByRole('button',{name:'打开浏览器协作'});
 expect(collaborationApi.browserStatus).toHaveBeenCalledTimes(2);
 expect(collaborationApi.browser).not.toHaveBeenCalled();
});

it('shows a host launch failure before the opening controls',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'failed',code:'BROWSER_NOT_FOUND',error:'Chrome executable was not found'});
 render(<SharedBrowser session={session}/>);
 const error=await screen.findByText('Chrome executable was not found');
 const open=screen.getByRole('button',{name:'打开浏览器协作'});
 expect(error.compareDocumentPosition(open)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(collaborationApi.browser).not.toHaveBeenCalled();
});

it('an open timeout recovers by status and snapshot without repeating the open command',async()=>{
 vi.mocked(collaborationApi.browser).mockImplementation(async(_id,request)=>{if(request.action==='open')throw timeoutError();return frame;});
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'closed'}).mockResolvedValue({state:'open'});
 render(<SharedBrowser session={session}/>);
 fireEvent.click(await openingButton());
 await screen.findByAltText('所选主机上的实时网页预览');
 expect(browserActions().filter(action=>action==='open')).toHaveLength(1);
 expect(screen.queryByText('Host request timed out')).toBeNull();
 expect(browserActions().every(action=>action==='open'||action==='snapshot')).toBe(true);
 expect(collaborationApi.browserStatus).toHaveBeenCalledTimes(2);
});

it('waits for a late opening result without resending commands',async()=>{
 vi.useFakeTimers();
 vi.mocked(collaborationApi.browser).mockImplementation(async(_id,request)=>{if(request.action==='open')throw timeoutError();return frame;});
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'closed'}).mockResolvedValueOnce({state:'opening'}).mockResolvedValue({state:'open'});
 render(<SharedBrowser session={session}/>);
 await act(async()=>{});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'打开浏览器协作'}));});
 expect(screen.queryByAltText('所选主机上的实时网页预览')).toBeNull();
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByAltText('所选主机上的实时网页预览')).toBeTruthy();
 expect(browserActions().filter(action=>action==='open')).toHaveLength(1);
 expect(browserActions().every(action=>action==='open'||action==='snapshot')).toBe(true);
});

it('stops automatic opening checks after the bounded recovery window',async()=>{
 vi.useFakeTimers();
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'closed'}).mockResolvedValue({state:'opening'});
 vi.mocked(collaborationApi.browser).mockRejectedValue(timeoutError());
 render(<SharedBrowser session={session}/>);
 await act(async()=>{});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'打开浏览器协作'}));});
 await act(async()=>{await vi.advanceTimersByTimeAsync(62000);});
 const checks=vi.mocked(collaborationApi.browserStatus).mock.calls.length;
 expect(screen.getByText('浏览器状态暂未确认')).toBeTruthy();
 expect(screen.getByRole('button',{name:'重新检查'})).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(120000);});
 expect(collaborationApi.browserStatus).toHaveBeenCalledTimes(checks);
 expect(browserActions()).toEqual(['open']);
});

it('remounting the same session restores its browser without a second open',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'open'});
 const first=render(<SharedBrowser session={session}/>);
 await screen.findByAltText('所选主机上的实时网页预览');
 first.unmount();
 render(<SharedBrowser session={session}/>);
 await screen.findByAltText('所选主机上的实时网页预览');
 expect(browserActions()).toEqual(['snapshot','snapshot']);
 expect(vi.mocked(collaborationApi.browserStatus).mock.calls.map(call=>call[0])).toEqual(['s','s']);
});

it('ignores a late status response after changing sessions',async()=>{
 const old=deferred<{state:'open'}>();
 vi.mocked(collaborationApi.browserStatus).mockImplementation(id=>id==='s'?old.promise:Promise.resolve({state:'closed'}));
 const view=render(<SharedBrowser session={session}/>);
 view.rerender(<SharedBrowser session={{...session,id:'other',machineName:'Other host'}}/>);
 await screen.findByRole('button',{name:'打开浏览器协作'});
 await act(async()=>{old.resolve({state:'open'});});
 expect(screen.getByText('Other host')).toBeTruthy();
 expect(screen.queryByAltText('所选主机上的实时网页预览')).toBeNull();
 expect(collaborationApi.browser).not.toHaveBeenCalled();
});

it('ignores a late snapshot after changing sessions',async()=>{
 const old=deferred<BrowserFrame>();
 vi.mocked(collaborationApi.browserStatus).mockImplementation(async id=>({state:id==='s'?'open':'closed'}));
 vi.mocked(collaborationApi.browser).mockReturnValue(old.promise);
 const view=render(<SharedBrowser session={session}/>);
 await waitFor(()=>expect(browserActions()).toEqual(['snapshot']));
 view.rerender(<SharedBrowser session={{...session,id:'other',machineName:'Other host'}}/>);
 await screen.findByRole('button',{name:'打开浏览器协作'});
 await act(async()=>{old.resolve({...frame,title:'Old session page'});});
 expect(screen.queryByText('Old session page')).toBeNull();
 expect(screen.queryByAltText('所选主机上的实时网页预览')).toBeNull();
});

it('a recovered pending action still requires explicit approval and keeps its revision',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'open'});
 vi.mocked(collaborationApi.browser).mockResolvedValue({...frame,mode:'agent',revision:7,pending:{id:'approval',action:{action:'navigate',url:'https://example.test/search'}}});
 render(<SharedBrowser session={session}/>);
 await screen.findByText('AI 想执行这一步，请你确认');
 expect(browserActions()).toEqual(['snapshot']);
 fireEvent.click(screen.getByRole('button',{name:'允许这一步'}));
 await waitFor(()=>expect(vi.mocked(collaborationApi.browser).mock.calls.some(([id,request])=>id==='s'&&request.action==='approve'&&request.pendingId==='approval'&&request.revision===7)).toBe(true));
 expect(browserActions().filter(action=>action==='approve')).toHaveLength(1);
});

it('an uncertain navigation is checked but never replayed',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'open'});
 vi.mocked(collaborationApi.browser).mockImplementation(async(_id,request)=>{if(request.action==='navigate')throw timeoutError();return frame;});
 render(<SharedBrowser session={session}/>);
 await screen.findByAltText('所选主机上的实时网页预览');
 fireEvent.change(screen.getByLabelText('网页地址'),{target:{value:'https://example.test/search'}});
 fireEvent.click(screen.getByRole('button',{name:'打开'}));
 await waitFor(()=>expect(browserActions().filter(action=>action==='snapshot')).toHaveLength(2));
 expect(browserActions().filter(action=>action==='navigate')).toHaveLength(1);
 expect(browserActions().every(action=>action==='navigate'||action==='snapshot')).toBe(true);
 expect(collaborationApi.browserStatus).toHaveBeenCalledTimes(2);
});

it('retains the last preview when status is lost and disables browser operations',async()=>{
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'open'}).mockRejectedValue(new Error('Host connection lost'));
 vi.mocked(collaborationApi.browser).mockResolvedValueOnce({...frame,title:'Last confirmed page'}).mockRejectedValue(timeoutError());
 render(<SharedBrowser session={session}/>);
 await screen.findByText('Last confirmed page');
 fireEvent.click(screen.getByRole('button',{name:'交给 AI'}));
 await screen.findByText('浏览器状态暂未确认');
 expect(screen.getByAltText('所选主机上的实时网页预览')).toBeTruthy();
 expect(screen.getByText('Last confirmed page')).toBeTruthy();
 expect((screen.getByRole('button',{name:'交给 AI'}) as HTMLButtonElement).disabled).toBe(true);
 expect(browserActions().filter(action=>action==='handoff')).toHaveLength(1);
 expect(browserActions().filter(action=>action==='open')).toHaveLength(0);
});

it('closing a browser stops preview polling and never reopens it',async()=>{
 vi.useFakeTimers();
 vi.mocked(collaborationApi.browserStatus).mockResolvedValueOnce({state:'open'}).mockResolvedValue({state:'closed'});
 render(<SharedBrowser session={session}/>);
 await act(async()=>{});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'关闭浏览器'}));});
 expect(screen.getByRole('button',{name:'打开浏览器协作'})).toBeTruthy();
 const reads=vi.mocked(collaborationApi.browserStatus).mock.calls.length;
 const calls=browserActions();
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(collaborationApi.browserStatus).toHaveBeenCalledTimes(reads);
 expect(browserActions()).toEqual(calls);
 expect(browserActions().filter(action=>action==='close')).toHaveLength(1);
 expect(browserActions().filter(action=>action==='open')).toHaveLength(0);
});

it('a late opening response cannot populate a different session',async()=>{
 const old=deferred<BrowserFrame>();
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'closed'});
 vi.mocked(collaborationApi.browser).mockReturnValue(old.promise);
 const view=render(<SharedBrowser session={session}/>);
 fireEvent.click(await openingButton());
 await waitFor(()=>expect(browserActions()).toEqual(['open']));
 view.rerender(<SharedBrowser session={{...session,id:'other',machineName:'Other host'}}/>);
 await openingButton();
 await act(async()=>{old.resolve({...frame,title:'Old opened browser'});});
 expect(screen.getByText('Other host')).toBeTruthy();
 expect(screen.queryByText('Old opened browser')).toBeNull();
 expect(screen.queryByAltText('所选主机上的实时网页预览')).toBeNull();
 expect(vi.mocked(collaborationApi.browser).mock.calls.map(call=>call[0])).toEqual(['s']);
});

it('a lost approval response never approves the same pending action again',async()=>{
 const pendingFrame={...frame,mode:'agent' as const,revision:9,pending:{id:'approval',action:{action:'navigate' as const,url:'https://example.test/search'}}};
 vi.mocked(collaborationApi.browserStatus).mockResolvedValue({state:'open'});
 vi.mocked(collaborationApi.browser).mockImplementation(async(_id,request)=>{if(request.action==='approve')throw timeoutError();return pendingFrame;});
 render(<SharedBrowser session={session}/>);
 await screen.findByText('AI 想执行这一步，请你确认');
 fireEvent.click(screen.getByRole('button',{name:'允许这一步'}));
 await waitFor(()=>expect(browserActions().filter(action=>action==='snapshot')).toHaveLength(2));
 expect(browserActions().filter(action=>action==='approve')).toHaveLength(1);
 expect(screen.getByText('AI 想执行这一步，请你确认')).toBeTruthy();
 expect(browserActions().every(action=>action==='approve'||action==='snapshot')).toBe(true);
});
