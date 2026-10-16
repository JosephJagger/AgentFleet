// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BuzhoushanScreensaver} from './components/BuzhoushanScreensaver';
import {VOICE_STYLES,parseScreensaverPrefs,requestVoiceScreensaver,saveScreensaverPrefs,setScreensaverPreview} from './lib/buzhoushan-idle';
vi.mock('./i18n',()=>({t:(value:string,...args:unknown[])=>value.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{cleanup();vi.restoreAllMocks();localStorage.clear();vi.useRealTimers();});
const saver=()=>document.querySelector('.buzhou-saver') as HTMLElement;
const detail=(over:object={})=>({hostOnline:true,events:[],session:{id:'s',activeTurnId:'t',state:{currentTurn:'in_progress',reachability:'live'}}, ...over}) as never;

it('appears after the idle time and any input dismisses it without being intercepted',()=>{
 saveScreensaverPrefs({enabled:true,seconds:30,mode:'matrix',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(29_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(1_500);});expect(saver().dataset.active).toBe('true');
 const click=vi.fn();document.addEventListener('pointerdown',click);
 fireEvent.pointerDown(document.body);
 expect(click).toHaveBeenCalled();expect(saver().dataset.active).toBe('false');
});
it('resets the timer on activity and never starts when disabled',()=>{
 saveScreensaverPrefs({enabled:true,seconds:30,mode:'matrix',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{vi.advanceTimersByTime(20_000);});fireEvent.keyDown(window,{key:'a'});
 act(()=>{vi.advanceTimersByTime(20_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{saveScreensaverPrefs({enabled:false,seconds:30,mode:'matrix',quality:'auto',autoVoice:true});});
 act(()=>{vi.advanceTimersByTime(120_000);});expect(saver().dataset.active).toBe('false');
});
it('shows task status as counts only and a standby label otherwise',()=>{
 saveScreensaverPrefs({enabled:true,seconds:10,mode:'matrix',quality:'auto',autoVoice:true});
 const {rerender}=render(<BuzhoushanScreensaver/>);
 expect(screen.getByRole('status',{hidden:true}).textContent).toContain('待命中');
 rerender(<BuzhoushanScreensaver detail={detail()}/>);
 expect(saver().dataset.busy).toBe('true');
 expect(screen.getByRole('status',{hidden:true}).textContent).toContain('任务执行中');
});
it('clamps and recovers preferences',()=>{
 expect(parseScreensaverPrefs('bad')).toEqual({enabled:true,seconds:30,mode:'auto',quality:'auto',autoVoice:true});
 expect(parseScreensaverPrefs('{"enabled":false,"seconds":1}')).toEqual({enabled:false,seconds:10,mode:'auto',quality:'auto',autoVoice:true});
 expect(parseScreensaverPrefs('{"seconds":99999}').seconds).toBe(600);
});
it('previews on demand and ends on the next click without waiting for idle',()=>{
 saveScreensaverPrefs({enabled:false,seconds:30,mode:'matrix',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{setScreensaverPreview(true);});expect(saver().dataset.active).toBe('true');
 act(()=>{vi.advanceTimersByTime(400);});fireEvent.pointerDown(document.body);
 expect(saver().dataset.active).toBe('false');
});
it('covers only the workspace so side introductions stay visible',()=>{
 const shell=document.createElement('div');shell.className='app-shell';document.body.append(shell);
 shell.getBoundingClientRect=()=>({left:240,top:44,width:1440,height:810,right:1680,bottom:854,x:240,y:44,toJSON(){}}) as DOMRect;
 saveScreensaverPrefs({enabled:false,seconds:30,mode:'matrix',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{setScreensaverPreview(true);});
 expect(saver().style.left).toBe('240px');expect(saver().style.width).toBe('1440px');expect(saver().style.height).toBe('810px');
 shell.remove();
});
it('rejects unknown effect modes',()=>{
 expect(parseScreensaverPrefs('{"mode":"hack"}').mode).toBe('auto');
 expect(parseScreensaverPrefs('{"mode":"matrix"}').mode).toBe('matrix');
});

import {voiceStatus} from './lib/voice-status';
const call=(phase:'connecting'|'connected'|'recovering'|'idle',over:object={})=>voiceStatus.publish('panel',{phase,muted:false,kind:'global',...over} as never);
const connect=(over:object={})=>{call('connecting',over);call('connected',over);};
afterEach(()=>{voiceStatus.release('panel');setScreensaverPreview(false);});

it('a connected global call enters the voiceprint screensaver; only a click or key leaves it, mouse movement does not',()=>{
 saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 expect(saver().dataset.active).toBe('false');
 act(()=>{connect();});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});
 expect(saver().dataset.active).toBe('true');expect(saver().dataset.mode).toBe('glyph');
 fireEvent.pointerMove(document.body,{clientX:50,clientY:50});act(()=>{vi.advanceTimersByTime(1000);});
 expect(saver().dataset.active).toBe('true');                       // movement keeps it
 fireEvent.pointerDown(document.body);
 expect(saver().dataset.active).toBe('false');                      // a click leaves it
 act(()=>{call('connected',{muted:true});});act(()=>{vi.advanceTimersByTime(900);});expect(saver().dataset.active).toBe('false'); // same call (only muted changed): no re-entry
 act(()=>{call('idle');call('connecting');call('connected');});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});
 expect(saver().dataset.active).toBe('true');
 fireEvent.keyDown(window,{key:'a'});expect(saver().dataset.active).toBe('false'); // a key leaves it
});
it('left and right arrows switch between the existing effects without leaving, and the on-screen arrows work',()=>{
 saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{connect();});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});
 expect(saver().dataset.mode).toBe('glyph');                                                               // every call starts with the glyph ripples
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(saver().dataset.mode).toBe('particles');expect(saver().dataset.active).toBe('true');
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(saver().dataset.mode).toBe('smoke');
 fireEvent.keyDown(window,{key:'ArrowLeft'});fireEvent.keyDown(window,{key:'ArrowLeft'});expect(saver().dataset.mode).toBe('glyph');
 fireEvent.keyDown(window,{key:'ArrowLeft'});expect(saver().dataset.mode).toBe('proton');                  // wraps around
 fireEvent.click(screen.getByLabelText('下一个声纹'));expect(saver().dataset.mode).toBe('glyph');
 expect(saver().dataset.active).toBe('true');                                                              // the arrow buttons are not a "click anywhere"
 expect(VOICE_STYLES).toHaveLength(9);expect(new Set(VOICE_STYLES).size).toBe(9);
});
it('shows the voice coordinator connection state, including muted, and hanging up leaves the voiceprint mode',()=>{
 saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{call('connecting');});
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('语音总控 连接中');
 act(()=>{call('connected');});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('语音总控 已连接');
 act(()=>{call('connected',{muted:true});});
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('已静音');
 expect(saver().dataset.active).toBe('true');
 act(()=>{call('idle');});
 expect(saver().dataset.active).toBe('false');expect(document.querySelector('.buzhou-saver__voice')).toBeNull();
});
it('does not enter on session voice, when disabled, or when automatic entry is switched off, and recovery is not a new connection',()=>{
 saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{connect({kind:'session'});});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');});
 act(()=>{saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:false});});
 act(()=>{connect();});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');saveScreensaverPrefs({enabled:false,seconds:600,mode:'auto',quality:'auto',autoVoice:true});});
 act(()=>{connect();});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});expect(saver().dataset.active).toBe('false');
 act(()=>{call('idle');saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});});
 act(()=>{call('connecting');call('connected');call('recovering');call('connected');});
 const seq=voiceStatus.get().connectedSeq;act(()=>{call('recovering');call('connected');});
 expect(voiceStatus.get().connectedSeq).toBe(seq);                                                         // recovery never counts
});
it('an idle panel can never overwrite another panel\'s live call state',()=>{
 voiceStatus.publish('a',{phase:'connecting',muted:false,kind:'global'});voiceStatus.publish('a',{phase:'connected',muted:false,kind:'global'});
 voiceStatus.publish('b',{phase:'idle',muted:false,kind:'session'});voiceStatus.release('b');
 expect(voiceStatus.get().phase).toBe('connected');
 voiceStatus.release('a');expect(voiceStatus.get().phase).toBe('idle');
});

it('the toolbar request raises the voice screensaver immediately after leaving it, only while a call is connected',()=>{
 saveScreensaverPrefs({enabled:true,seconds:600,mode:'auto',quality:'auto',autoVoice:true});
 render(<BuzhoushanScreensaver/>);
 act(()=>{requestVoiceScreensaver();});expect(saver().dataset.active).toBe('false');                        // no call: nothing to raise
 act(()=>{connect();});act(()=>{vi.advanceTimersByTime(400);});act(()=>{vi.advanceTimersByTime(500);});
 fireEvent.keyDown(window,{key:'ArrowRight'});expect(saver().dataset.mode).toBe('particles');
 fireEvent.keyDown(window,{key:'a'});expect(saver().dataset.active).toBe('false');                         // left by a key
 act(()=>{requestVoiceScreensaver();});
 expect(saver().dataset.active).toBe('true');expect(saver().dataset.mode).toBe('particles');                // back at once, same style, no idle wait
 expect(document.querySelector('.buzhou-saver__voice')!.textContent).toContain('语音总控 已连接');
 act(()=>{vi.advanceTimersByTime(500);});fireEvent.pointerDown(document.body);expect(saver().dataset.active).toBe('false'); // still click/key to leave
 act(()=>{call('idle');});act(()=>{requestVoiceScreensaver();});expect(saver().dataset.active).toBe('false'); // hung up: ignored
});
