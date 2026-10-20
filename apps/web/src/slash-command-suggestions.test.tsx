// @vitest-environment jsdom
import {useRef,useState} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ComposerCommandPalette,type CommandPaletteHandle} from './components/ComposerCommandPalette';
import type {ComposerCommand} from './lib/composer-commands';
afterEach(cleanup);
const native=[{name:'workflow',description:'Launch a workflow',hint:'<name> | runs | pause | resume | stop | save'}];
function Composer({commands=native,onSend=vi.fn(),onApplied=vi.fn()}:{commands?:ComposerCommand[];onSend?:()=>void;onApplied?:()=>void}){
 const input=useRef<HTMLTextAreaElement>(null),handle=useRef<CommandPaletteHandle>(null),[prompt,setPrompt]=useState('');
 return <form className="composer" onSubmit={e=>{e.preventDefault();if(!handle.current?.submit())onSend();}}><div className="composer-input">
  <ComposerCommandPalette ref={handle} anchor={input} prompt={prompt} commands={commands} onPrompt={setPrompt} onApplied={onApplied} label="命令"/>
  <textarea ref={input} aria-label="消息" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{handle.current?.keydown(e);}}/><button>发送</button>
 </div></form>;
}
const config=(save:(value:string)=>Promise<void>):ComposerCommand=>({name:'model',description:'模型',choices:[{value:'a',label:'Alpha'},{value:'b',label:'Beta'}],apply:save});
const input=()=>screen.getByLabelText('消息') as HTMLTextAreaElement;
it('native selection completes only, floats outside layout, and needs explicit submission',()=>{
 const send=vi.fn();const view=render(<Composer onSend={send}/>);
 fireEvent.change(input(),{target:{value:'/work'}});
 const menu=screen.getByRole('group',{name:'命令'});
 expect(menu.closest('.completion-floating')?.parentElement).toBe(document.body);
 expect(view.container.querySelector('.composer-input')?.contains(menu)).toBe(false);
 fireEvent.wheel(menu,{deltaY:100});expect(screen.getByRole('group')).toBeTruthy();
 fireEvent.click(screen.getByRole('option',{name:/workflow/}));
 expect(input().value).toBe('/workflow ');expect(screen.queryByRole('group')).toBeNull();expect(send).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('发送'));expect(send).toHaveBeenCalledOnce();
});
it('partial command click opens inline values; clicking a value saves once and clears without chat',async()=>{
 const save=vi.fn().mockResolvedValue(undefined),send=vi.fn();render(<Composer commands={[config(save)]} onSend={send}/>);
 fireEvent.change(input(),{target:{value:'/mo'}});fireEvent.click(screen.getByRole('option',{name:/model/}));
 expect(input().value).toBe('/model ');expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('option',{name:'Beta'}));await waitFor(()=>expect(input().value).toBe(''));
 expect(save).toHaveBeenCalledWith('b');expect(send).not.toHaveBeenCalled();
});
it('Tab, arrows and Enter work; Escape preserves text and IME / modified Enter do not apply',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<Composer commands={[config(save)]}/>);
 fireEvent.change(input(),{target:{value:'/mo'}});fireEvent.keyDown(input(),{key:'Tab'});
 expect(input().value).toBe('/model ');
 fireEvent.keyDown(input(),{key:'Enter',isComposing:true});fireEvent.keyDown(input(),{key:'Enter',ctrlKey:true});expect(save).not.toHaveBeenCalled();
 fireEvent.keyDown(input(),{key:'ArrowDown'});fireEvent.keyDown(input(),{key:'Enter'});
 await waitFor(()=>expect(save).toHaveBeenCalledWith('b'));
 fireEvent.change(input(),{target:{value:'/mo'}});fireEvent.keyDown(input(),{key:'Escape'});expect(screen.queryByRole('group')).toBeNull();expect(input().value).toBe('/mo');
});
it('full arguments use exact choices; invalid values and conflicts retain the draft without task dispatch',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('保存冲突')),send=vi.fn();render(<Composer commands={[config(save)]} onSend={send}/>);
 fireEvent.change(input(),{target:{value:'/model missing'}});fireEvent.submit(input().form!);expect(screen.getByRole('alert').textContent).toContain('有效选项');expect(save).not.toHaveBeenCalled();
 fireEvent.change(input(),{target:{value:'/model b'}});fireEvent.submit(input().form!);
 await screen.findByText('保存冲突');expect(input().value).toBe('/model b');expect(send).not.toHaveBeenCalled();
});
it('permissions need inline confirmation and cannot apply just by selecting or pressing Enter again',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<Composer commands={[{name:'permissions',description:'权限',apply:save,choices:[{value:'always',label:'允许',confirmation:'改变审批方式'}]}]}/>);
 fireEvent.change(input(),{target:{value:'/permissions always'}});fireEvent.submit(input().form!);expect(save).not.toHaveBeenCalled();
 fireEvent.keyDown(input(),{key:'Enter'});expect(save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'确认'}));await waitFor(()=>expect(save).toHaveBeenCalledOnce());
});
it('pending save prevents duplicates and does not clear a newer draft or an unmounted session',async()=>{
 let done!:()=>void;const save=vi.fn(()=>new Promise<void>(resolve=>{done=resolve;})),applied=vi.fn();
 const view=render(<Composer commands={[config(save)]} onApplied={applied}/>);
 fireEvent.change(input(),{target:{value:'/model b'}});fireEvent.submit(input().form!);fireEvent.submit(input().form!);expect(save).toHaveBeenCalledOnce();
 fireEvent.change(input(),{target:{value:'新草稿'}});await act(async()=>done());expect(input().value).toBe('新草稿');expect(applied).not.toHaveBeenCalled();
 fireEvent.change(input(),{target:{value:'/model b'}});fireEvent.submit(input().form!);view.unmount();await act(async()=>done());expect(applied).not.toHaveBeenCalled();
});
it('disabled capability explains why and help opens the list without modal or send',()=>{
 const save=vi.fn(),send=vi.fn();render(<Composer commands={[{...config(save),unavailable:'能力未提供'},{name:'help',description:'帮助'}]} onSend={send}/>);
 fireEvent.change(input(),{target:{value:'/model b'}});fireEvent.submit(input().form!);expect(screen.getByRole('alert').textContent).toBe('能力未提供');expect(save).not.toHaveBeenCalled();
 fireEvent.change(input(),{target:{value:'/help'}});fireEvent.submit(input().form!);expect(input().value).toBe('/');expect(screen.getByRole('option',{name:/model/})).toBeTruthy();expect(send).not.toHaveBeenCalled();
});

it('entering a bare setting command opens choices without silently selecting inheritance',()=>{
 const save=vi.fn();render(<Composer commands={[config(save)]}/>);
 fireEvent.change(input(),{target:{value:'/model'}});fireEvent.keyDown(input(),{key:'Enter'});
 expect(input().value).toBe('/model ');expect(save).not.toHaveBeenCalled();expect(screen.getByRole('option',{name:'Beta'})).toBeTruthy();
});
