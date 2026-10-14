// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BuzhoushanScreensaver} from './components/BuzhoushanScreensaver';
import {parseScreensaverPrefs,saveScreensaverPrefs} from './lib/buzhoushan-idle';
vi.mock('./i18n',()=>({t:(value:string,...args:unknown[])=>value.replace(/\{(\d+)\}/g,(_,i)=>String(args[Number(i)]))}));
beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{cleanup();localStorage.clear();vi.useRealTimers();});
const saver=()=>document.querySelector('.buzhou-saver') as HTMLElement;
const detail=(over:object={})=>({hostOnline:true,events:[],session:{id:'s',activeTurnId:'t',state:{currentTurn:'in_progress',reachability:'live'}}, ...over}) as never;

it('appears after the idle time and any input dismisses it without being intercepted',()=>{
 saveScreensaverPrefs({enabled:true,seconds:30});
 render(<BuzhoushanScreensaver/>);
 expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(29_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{vi.advanceTimersByTime(1_500);});expect(saver().dataset.active).toBe('true');
 const click=vi.fn();document.addEventListener('pointerdown',click);
 fireEvent.pointerDown(document.body);
 expect(click).toHaveBeenCalled();expect(saver().dataset.active).toBe('false');
});
it('resets the timer on activity and never starts when disabled',()=>{
 saveScreensaverPrefs({enabled:true,seconds:30});
 render(<BuzhoushanScreensaver/>);
 act(()=>{vi.advanceTimersByTime(20_000);});fireEvent.keyDown(window,{key:'a'});
 act(()=>{vi.advanceTimersByTime(20_000);});expect(saver().dataset.active).toBe('false');
 act(()=>{saveScreensaverPrefs({enabled:false,seconds:30});});
 act(()=>{vi.advanceTimersByTime(120_000);});expect(saver().dataset.active).toBe('false');
});
it('shows task status as counts only and a standby label otherwise',()=>{
 saveScreensaverPrefs({enabled:true,seconds:10});
 const {rerender}=render(<BuzhoushanScreensaver/>);
 expect(screen.getByRole('status',{hidden:true}).textContent).toContain('待命中');
 rerender(<BuzhoushanScreensaver detail={detail()}/>);
 expect(saver().dataset.busy).toBe('true');
 expect(screen.getByRole('status',{hidden:true}).textContent).toContain('任务执行中');
});
it('clamps and recovers preferences',()=>{
 expect(parseScreensaverPrefs('bad')).toEqual({enabled:true,seconds:30});
 expect(parseScreensaverPrefs('{"enabled":false,"seconds":1}')).toEqual({enabled:false,seconds:10});
 expect(parseScreensaverPrefs('{"seconds":99999}').seconds).toBe(600);
});
