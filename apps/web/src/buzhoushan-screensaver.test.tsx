// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BuzhoushanScreensaver} from './components/BuzhoushanScreensaver';
import {SCREENSAVER_ORDER,parseScreensaverPrefs,requestScreensaver,saveScreensaverPrefs} from './lib/buzhoushan-idle';
import {voiceStatus} from './lib/voice-status';
vi.mock('./i18n',()=>({t:(value:string,...args:unknown[])=>value.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{cleanup();voiceStatus.release('panel');vi.restoreAllMocks();localStorage.clear();vi.useRealTimers();});

const saver=()=>document.querySelector('.buzhou-saver') as HTMLElement;
const detail=(over:object={})=>({hostOnline:true,events:[],session:{id:'s',activeTurnId:'t',state:{currentTurn:'in_progress',reachability:'live'}}, ...over}) as never;
const prefs=(over:object={})=>saveScreensaverPrefs({enabled:true,seconds:30,mode:'matrix',quality:'auto',autoVoice:true,...over} as never);
/** A freshly raised screensaver ignores input for 400 ms (the click that raised it); let that pass. */
const settle=()=>{act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});};
const call=(phase:'connecting'|'connected'|'recovering'|'idle',over:object={})=>voiceStatus.publish('panel',{phase,muted:false,kind:'global',...over} as never);
const connect=(over:object={})=>{call('connecting',over);call('connected',over);};
const caption=()=>document.querySelector('.buzhou-saver__caption')!.textContent||'';

it('appears after the idle time; mouse movement does not end it, a click or a key does',()=>{
 prefs({seconds:30});
 render(<BuzhoushanScreensaver/>);
 expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(29_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(1_500);});expect(saver().dataset.active).toBe('true');expect(saver().dataset.source).toBe('idle');
 settle();
 fireEvent.pointerMove(document.body,{clientX:20,clientY:20});act(()=>{vi.advanceTimersByTime(2000);});
 expect(saver().dataset.active).toBe('true');                                  // movement keeps it
 const seen=vi.fn();document.addEventListener('pointerdown',seen);
 fireEvent.pointerDown(document.body);
 expect(seen).toHaveBeenCalled();expect(saver().dataset.active).toBe('false'); // the click is not swallowed and leaves it
 act(()=>{vi.advanceTimersByTime(29_000);});expect(saver().dataset.active).toBe('false'); // the idle timer starts over
 act(()=>{vi.advanceTimersByTime(2_000);});expect(saver().dataset.active).toBe('true');
 settle();fireEvent.keyDown(window,{key:'a'});expect(saver().dataset.active).toBe('false');
});
it('activity resets the idle timer and a disabled screensaver never starts by itself',()=>{
 prefs({seconds:30});
 render(<BuzhoushanScreensaver/>);
 act(()=>{vi.advanceTimersByTime(20_000);});fireEvent.keyDown(window,{key:'a'});
 act(()=>{vi.advanceTimersByTime(20_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{prefs({enabled:false});});
 act(()=>{vi.advanceTimersByTime(120_000);});expect(saver().dataset.active).toBe('false');
});
it('shows task progress as counts only, or standby, in the one caption',()=>{
 prefs();
 const {rerender}=render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});
 expect(caption()).toContain('暂无运行中的项目任务');
 rerender(<BuzhoushanScreensaver detail={detail()}/>);
 expect(saver().dataset.busy).toBe('true');expect(caption()).toContain('任务执行中');
});
it('the toolbar request raises it at once, even when disabled, and a click leaves it',()=>{
 prefs({enabled:false});
 render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});
 expect(saver().dataset.active).toBe('true');expect(saver().dataset.source).toBe('manual');
 settle();fireEvent.pointerDown(document.body);expect(saver().dataset.active).toBe('false');
 act(()=>{requestScreensaver();});expect(saver().dataset.active).toBe('true');   // raised again straight away, no waiting
});
it('covers only the workspace so side introductions stay visible',()=>{
 const shell=document.createElement('div');shell.className='app-shell';document.body.append(shell);
 shell.getBoundingClientRect=()=>({left:240,top:44,width:1440,height:810,right:1680,bottom:854,x:240,y:44,toJSON(){}}) as DOMRect;
 prefs({enabled:false});
 render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});
 expect(saver().style.left).toBe('240px');expect(saver().style.width).toBe('1440px');expect(saver().style.height).toBe('810px');
 shell.remove();
});
it('keeps the voice sensitivity within 0.5–3 and falls back to 1 when it is unusable',()=>{
 expect(parseScreensaverPrefs('{"voiceSensitivity":0.1}').voiceSensitivity).toBe(0.5);
 expect(parseScreensaverPrefs('{"voiceSensitivity":9}').voiceSensitivity).toBe(3);
 expect(parseScreensaverPrefs('{"voiceSensitivity":1.84}').voiceSensitivity).toBe(1.8);
 for(const bad of ['"x"','null','""','{}','[]'])expect(parseScreensaverPrefs(`{"voiceSensitivity":${bad}}`).voiceSensitivity).toBe(1);
 expect(parseScreensaverPrefs('{}').voiceSensitivity).toBe(1);
});
it('clamps and recovers preferences and rejects unknown values',()=>{
 expect(parseScreensaverPrefs('bad')).toEqual({enabled:true,seconds:30,mode:'auto',quality:'auto',autoVoice:true,voiceSensitivity:1});
 expect(parseScreensaverPrefs('{"enabled":false,"seconds":1}')).toEqual({enabled:false,seconds:10,mode:'auto',quality:'auto',autoVoice:true,voiceSensitivity:1});
 expect(parseScreensaverPrefs('{"seconds":99999}').seconds).toBe(600);
 expect(parseScreensaverPrefs('{"mode":"hack"}').mode).toBe('auto');
 expect(parseScreensaverPrefs('{"mode":"matrix","autoVoice":false}')).toMatchObject({mode:'matrix',autoVoice:false});
 expect(parseScreensaverPrefs('{"mode":"rings"}').mode).toBe('auto');          // removed effects fall back
});

it('the arrows and the on-screen buttons switch effects without leaving; any other key, even a digit, leaves',()=>{
 prefs({mode:'auto'});
 render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});settle();
 const first=saver().dataset.mode;
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(saver().dataset.mode).toBe(SCREENSAVER_ORDER[(SCREENSAVER_ORDER.indexOf(first as never)+1)%9]);
 expect(saver().dataset.active).toBe('true');
 fireEvent.keyDown(window,{key:'ArrowLeft'});expect(saver().dataset.mode).toBe(first);
 fireEvent.click(screen.getByLabelText('下一个效果'));fireEvent.click(screen.getByLabelText('上一个效果'));
 expect(saver().dataset.mode).toBe(first);expect(saver().dataset.active).toBe('true');   // the arrow buttons are not "click anywhere"
 fireEvent.keyDown(window,{key:'3'});expect(saver().dataset.active).toBe('false');
 expect(SCREENSAVER_ORDER).toHaveLength(9);expect(SCREENSAVER_ORDER[0]).toBe('glyph');expect(new Set(SCREENSAVER_ORDER).size).toBe(9);
});
it('starts with the configured effect, rotates on its own only in auto mode, and stops rotating once an effect is picked',()=>{
 prefs({mode:'smoke'});
 const view=render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});expect(saver().dataset.mode).toBe('smoke');
 act(()=>{vi.advanceTimersByTime(100_000);});expect(saver().dataset.mode).toBe('smoke');       // fixed effect never rotates
 view.unmount();cleanup();
 prefs({mode:'auto'});
 render(<BuzhoushanScreensaver/>);
 act(()=>{requestScreensaver();});const start=saver().dataset.mode;
 act(()=>{vi.advanceTimersByTime(46_000);});expect(saver().dataset.mode).not.toBe(start);       // auto mode rotates (45 s)
 settle();fireEvent.keyDown(window,{key:'ArrowRight'});const picked=saver().dataset.mode;
 act(()=>{vi.advanceTimersByTime(100_000);});expect(saver().dataset.mode).toBe(picked);          // a picked effect stays
});

it('a connected global call raises the screensaver with the glyph ripples, with no rotation, and the click or key leaves it',()=>{
 prefs({seconds:600,mode:'auto'});
 render(<BuzhoushanScreensaver/>);
 expect(saver().dataset.active).toBe('false');
 act(()=>{connect();});settle();
 expect(saver().dataset.active).toBe('true');expect(saver().dataset.source).toBe('call');expect(saver().dataset.mode).toBe('glyph');
 act(()=>{vi.advanceTimersByTime(100_000);});expect(saver().dataset.mode).toBe('glyph');          // no auto-rotation during a call
 fireEvent.pointerMove(document.body,{clientX:50,clientY:50});expect(saver().dataset.active).toBe('true');
 fireEvent.pointerDown(document.body);expect(saver().dataset.active).toBe('false');
 act(()=>{call('connected',{muted:true});});act(()=>{vi.advanceTimersByTime(900);});expect(saver().dataset.active).toBe('false'); // same call: no re-entry
 act(()=>{call('idle');call('connecting');call('connected');});settle();expect(saver().dataset.active).toBe('true');           // a new call
});
it('shows the voice-call state, including muted, and hanging up ends only a screensaver the call raised',()=>{
 prefs({seconds:600});
 render(<BuzhoushanScreensaver/>);
 act(()=>{call('connecting');});
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('语音总控 连接中');
 act(()=>{call('connected');});settle();
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('语音总控 已连接');
 act(()=>{call('connected',{muted:true});});expect(caption()).toContain('已静音');
 expect(saver().dataset.active).toBe('true');
 act(()=>{call('idle');});expect(saver().dataset.active).toBe('false');expect(document.querySelector('.buzhou-saver__voice')).toBeNull();
 // A screensaver raised by hand, or by idling, stays when the call ends.
 act(()=>{connect();});settle();fireEvent.keyDown(window,{key:'a'});expect(saver().dataset.active).toBe('false');
 act(()=>{requestScreensaver();});expect(saver().dataset.source).toBe('manual');
 act(()=>{call('idle');});expect(saver().dataset.active).toBe('true');
});
it('the toolbar raises it again right after leaving during a call, at the glyph ripples with the call state shown',()=>{
 prefs({seconds:600});
 render(<BuzhoushanScreensaver/>);
 act(()=>{connect();});settle();
 fireEvent.keyDown(window,{key:'ArrowRight'});fireEvent.keyDown(window,{key:'a'});expect(saver().dataset.active).toBe('false');
 act(()=>{requestScreensaver();});
 expect(saver().dataset.active).toBe('true');expect(caption()).toContain('语音总控 已连接');
});
it('does not raise itself on session voice, when disabled, or when automatic entry is off, and recovery is not a new connection',()=>{
 prefs({seconds:600});
 render(<BuzhoushanScreensaver/>);
 act(()=>{connect({kind:'session'});});settle();expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');prefs({seconds:600,autoVoice:false});});
 act(()=>{connect();});settle();expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');prefs({seconds:600,enabled:false});});
 act(()=>{connect();});settle();expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');prefs({seconds:600});});
 act(()=>{call('connecting');call('connected');call('recovering');call('connected');});
 const seq=voiceStatus.get().connectedSeq;act(()=>{call('recovering');call('connected');});
 expect(voiceStatus.get().connectedSeq).toBe(seq);                                                  // recovery never counts
});
it('an idle panel can never overwrite another panel\'s live call state',()=>{
 voiceStatus.publish('a',{phase:'connecting',muted:false,kind:'global'});voiceStatus.publish('a',{phase:'connected',muted:false,kind:'global'});
 voiceStatus.publish('b',{phase:'idle',muted:false,kind:'session'});voiceStatus.release('b');
 expect(voiceStatus.get().phase).toBe('connected');
 voiceStatus.release('a');expect(voiceStatus.get().phase).toBe('idle');
});

it('stays up and shows the re-dial while an unexpectedly ended call is being re-dialled',()=>{
 prefs({seconds:600});
 render(<BuzhoushanScreensaver/>);
 act(()=>{connect();});settle();expect(saver().dataset.source).toBe('call');
 act(()=>{call('connecting',{redial:1});});                                    // the call ended unexpectedly and is being re-dialled
 expect(saver().dataset.active).toBe('true');                                     // a screensaver the call raised does not flicker away
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('自动重拨中（1/2）');
 act(()=>{call('connecting',{redial:1});call('connected',{redial:0});});
 expect(saver().dataset.active).toBe('true');
 act(()=>{call('idle');});expect(saver().dataset.active).toBe('false');         // and it still ends with the call itself
});


it('follows global sessions even when another conversation is selected, and updates on completion',()=>{
 const selected=detail({session:{id:'selected',state:{currentTurn:'none',reachability:'live'}}});
 const running={id:'other',activeTurnId:'turn',state:{currentTurn:'in_progress',reachability:'live'}} as never;
 const view=render(<BuzhoushanScreensaver detail={selected} sessions={[running]}/>);
 expect(caption()).toContain('任务执行中');
 view.rerender(<BuzhoushanScreensaver detail={selected} sessions={[]}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
 view.rerender(<BuzhoushanScreensaver sessions={[running,{...running as object,id:'third'} as never]}/>);
 expect(caption()).toContain('进行中的项目会话：2');
 view.rerender(<BuzhoushanScreensaver sessions={[]} connected={false}/>);
 expect(caption()).toContain('运行状态待确认');
});
it('does not call offline work idle or use a stale selected turn over a newer dashboard turn',()=>{
 const session={id:'s',activeTurnId:'new',state:{currentTurn:'in_progress',reachability:'live'}} as never;
 const stale=detail({session:{id:'s',activeTurnId:'old',state:{currentTurn:'completed',reachability:'live'}}});
 const view=render(<BuzhoushanScreensaver detail={stale} sessions={[session]}/>);
 expect(caption()).toContain('任务执行中');
 view.rerender(<BuzhoushanScreensaver sessions={[{id:'s',activeTurnId:'new',state:{currentTurn:'in_progress',reachability:'unreachable'}} as never]}/>);
 expect(caption()).toContain('运行状态待确认');
});
it('separates listening from project execution and keeps approval waits explicit',()=>{
 const running={id:'other',activeTurnId:'turn',state:{currentTurn:'in_progress',reachability:'live',waitReason:'approval'}} as never;
 const view=render(<BuzhoushanScreensaver sessions={[running]}/>);
 act(()=>{connect();});
 expect(caption()).toContain('等待确认');
 expect(caption()).toContain('聆听中');
 view.rerender(<BuzhoushanScreensaver sessions={[]}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
 expect(caption()).toContain('聆听中');
});

it('keeps a newer selected projection when the global list lags, but accepts a newer completion',()=>{
 const running={id:'s',activeTurnId:'t',projectionEpoch:1,sessionSeq:20,lastActivityAt:'2026-10-16T12:00:00Z',state:{currentTurn:'in_progress',reachability:'live'}};
 const selected=detail({session:running});
 const view=render(<BuzhoushanScreensaver detail={selected} sessions={[]}/>);
 expect(caption()).toContain('任务执行中');
 view.rerender(<BuzhoushanScreensaver detail={selected} sessions={[{...running,sessionSeq:19,state:{...running.state,currentTurn:'completed'}} as never]}/>);
 expect(caption()).toContain('任务执行中');
 view.rerender(<BuzhoushanScreensaver detail={selected} sessions={[{...running,sessionSeq:21,state:{...running.state,currentTurn:'completed'}} as never]}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
});

it('does not let old detail terminal events suppress a newer global running projection',()=>{
 const running={id:'s',activeTurnId:'t',projectionEpoch:1,sessionSeq:21,state:{currentTurn:'in_progress',reachability:'live'}};
 render(<BuzhoushanScreensaver sessions={[running as never]} detail={detail({session:{...running,sessionSeq:19},events:[{nativeTurnId:'t',type:'turn.completed',sessionSeq:19}]})}/>);
 expect(caption()).toContain('任务执行中');
});

it('refreshes metadata on every entry and while open without overlapping or continuing after exit',async()=>{
 prefs({enabled:false});
 let release!:()=>void;
 const refresh=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 render(<BuzhoushanScreensaver onRefresh={refresh}/>);
 expect(refresh).not.toHaveBeenCalled();
 act(()=>requestScreensaver());
 expect(refresh).toHaveBeenCalledTimes(1);
 act(()=>vi.advanceTimersByTime(10_000));
 expect(refresh).toHaveBeenCalledTimes(1);
 await act(async()=>release());
 act(()=>vi.advanceTimersByTime(5000));
 expect(refresh).toHaveBeenCalledTimes(2);
 await act(async()=>release());
 fireEvent.keyDown(window,{key:'Escape'});
 act(()=>vi.advanceTimersByTime(10_000));
 expect(refresh).toHaveBeenCalledTimes(2);
 act(()=>requestScreensaver());
 expect(refresh).toHaveBeenCalledTimes(3);
 await act(async()=>release());
});

it.each(['codex','claude','cursor','qwen','kimi','codebuddy','grok'])('maps real dashboard payloads for %s through running, approval and idle without provider filtering',async(provider)=>{
 const {api}=await import('./lib/api');
 let executionState='running';
 const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{
  const url=String(input);
  const session={logicalSessionId:'other',provider,executionState,reachability:'live',latestSessionSeq:10,projectionEpoch:1};
  const payload=url==='/api/auth/status'?{authenticated:true,user:{userId:'u'}}:
   url==='/api/dashboard'?{activitySessions:[session]}:{items:[]};
  return new Response(JSON.stringify(payload),{status:200});
 });
 const dashboard=await api.dashboard();
 expect(dashboard.activitySessions?.[0].provider).toBe(provider);
 const view=render(<BuzhoushanScreensaver sessions={dashboard.activitySessions}/>);
 expect(caption()).toContain('任务执行中');
 executionState='awaiting_approval';
 view.rerender(<BuzhoushanScreensaver sessions={(await api.dashboard()).activitySessions}/>);
 expect(caption()).toContain('等待确认');
 executionState='completed';
 view.rerender(<BuzhoushanScreensaver sessions={(await api.dashboard()).activitySessions}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
 executionState='idle';
 view.rerender(<BuzhoushanScreensaver sessions={(await api.dashboard()).activitySessions}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
 fetchMock.mockRestore();
});

it('does not let an offline idle host make all idle projects look uncertain',()=>{
 render(<BuzhoushanScreensaver sessions={[{id:'idle',state:{currentTurn:'none',reachability:'unreachable'}} as never]}/>);
 expect(caption()).toContain('暂无运行中的项目任务');
});

const savedSteps=()=>({sessionId:'s',nativeTurnId:'t',state:'running',source:'codex_app_server_events',freshness:'live',contentAvailable:true,waitingForApproval:false,limited:false,updatedAt:'2026-10-16T12:00:00Z',items:Array.from({length:25},(_,i)=>({id:`cmd-${i}`,kind:'commandExecution',status:i<11?'completed':'running',title:'private command',updatedAt:'2026-10-16T12:00:00Z'}))}) as never;
it('restores recorded activity counts from the persisted progress projection after a page remount',()=>{
 const input=detail({progress:savedSteps(),events:[]});
 const first=render(<BuzhoushanScreensaver detail={input}/>);
 expect(caption()).toContain('已完成 11 / 25 步');
 first.unmount();
 render(<BuzhoushanScreensaver detail={input}/>);
 expect(caption()).toContain('已完成 11 / 25 步');
 expect(caption()).not.toContain('private command');
});
it('keeps recorded counts when dashboard and detail sequence numbers differ within the same turn',()=>{
 const session={id:'s',activeTurnId:'t',projectionEpoch:1,sessionSeq:30,state:{currentTurn:'in_progress',reachability:'live'}};
 const input=detail({session:{...session,sessionSeq:25},progress:savedSteps(),events:[]});
 const view=render(<BuzhoushanScreensaver detail={input} sessions={[session as never]}/>);
 expect(caption()).toContain('已完成 11 / 25 步');
 view.rerender(<BuzhoushanScreensaver detail={input} sessions={[{...session,activeTurnId:'next'} as never]}/>);
 expect(caption()).toContain('任务执行中');
 expect(caption()).not.toContain('/ 25');
});
it('never shows counts from another turn or from content whose synchronization was disabled',()=>{
 const view=render(<BuzhoushanScreensaver detail={detail({progress:{...savedSteps() as object,nativeTurnId:'old'}})}/>);
 expect(caption()).not.toContain('/ 25');
 view.rerender(<BuzhoushanScreensaver detail={detail({progress:{...savedSteps() as object,contentAvailable:false}})}/>);
 expect(caption()).not.toContain('/ 25');
});
it('reads the activity endpoint on opening and restores counts without loading more timeline pages',async()=>{
 const {api}=await import('./lib/api');
 const read=vi.spyOn(api,'sessionProgress').mockResolvedValue(savedSteps());
 render(<BuzhoushanScreensaver detail={detail()}/>);
 expect(caption()).not.toContain('/ 25');
 await act(async()=>requestScreensaver());
 expect(read).toHaveBeenCalledWith('s',expect.any(AbortSignal),true);
 expect(caption()).toContain('已完成 11 / 25 步');
});

it('does not replace restored activity with the shorter detail preview on dashboard refresh, and keeps polling',async()=>{
 const {api}=await import('./lib/api');
 const full=savedSteps() as unknown as import('./lib/types').SessionProgress;
 const read=vi.spyOn(api,'sessionProgress').mockResolvedValue(full);
 const input=detail({progress:{...full,items:full.items.slice(-8),limited:true}});
 const view=render(<BuzhoushanScreensaver detail={input}/>);
 await act(async()=>requestScreensaver());
 expect(caption()).toContain('已完成 11 / 25 步');
 view.rerender(<BuzhoushanScreensaver detail={detail({progress:{...full,items:full.items.slice(-8),limited:true}})}/>);
 expect(caption()).toContain('已完成 11 / 25 步');
 read.mockResolvedValue({...full,items:full.items.map((item,i)=>i===11?{...item,status:'completed'}:item)});
 await act(async()=>vi.advanceTimersByTimeAsync(2000));
 expect(caption()).toContain('已完成 12 / 25 步');
});
