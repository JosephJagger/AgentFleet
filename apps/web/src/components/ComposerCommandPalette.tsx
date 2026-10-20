import {useEffect,useId,useImperativeHandle,useRef,useState,type Ref,type RefObject,type KeyboardEvent} from 'react';
import {X,Check} from 'lucide-react';
import {CompletionSurface} from './CompletionSurface';
import {t,systemText} from '../i18n';
import {parseComposerCommand,commandMatches,exactCommandChoice,type ComposerCommand,type CommandChoice} from '../lib/composer-commands';
import './slash-command-suggestions.css';

export interface CommandPaletteHandle {submit:()=>boolean;keydown:(event:KeyboardEvent<HTMLTextAreaElement>)=>boolean}
/** One completion surface; setting commands save through the same store as the send summary. */
export function ComposerCommandPalette({ref,anchor,prompt,commands,onPrompt,onApplied,label,disabled=false,onBusy}:{
 ref?:Ref<CommandPaletteHandle>;anchor:RefObject<HTMLTextAreaElement|null>;prompt:string;commands:ComposerCommand[];
 onPrompt:(value:string)=>void;onApplied:()=>void;label:string;disabled?:boolean;onBusy?:(busy:boolean)=>void;
}){
 const id=useId(),menu=useRef<HTMLDivElement>(null),live=useRef(true),saving=useRef(false),latest=useRef(prompt);latest.current=prompt;
 const [dismissed,setDismissed]=useState<string>(),[active,setActive]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [confirmation,setConfirmation]=useState<{command:ComposerCommand;choice:CommandChoice;prompt:string}>();
 const parsed=parseComposerCommand(prompt),command=commands.find(c=>c.name===parsed?.name);
 const choosing=!!command?.choices;
 const choices=choosing?command!.choices!.filter(c=>commandMatches(c,parsed?.args??'')):[];
 const matches=parsed&&!parsed.values?commands.filter(c=>c.name.startsWith(parsed.name)):[];
 const count=choosing?choices.length:matches.length;
 const visible=!!parsed&&dismissed!==prompt&&(count>0||choosing||!!error||!!confirmation);
 useEffect(()=>{setActive(0);setError('');setConfirmation(undefined);},[prompt]);
 useEffect(()=>{live.current=true;return()=>{live.current=false;onBusy?.(false);};},[onBusy]);
 useEffect(()=>{
  if(!visible)return;
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&event.target!==anchor.current&&!menu.current?.contains(event.target)){setDismissed(prompt);setConfirmation(undefined);}};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[visible,prompt,anchor]);
 useEffect(()=>{menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block:'nearest'});},[active]);
 useEffect(()=>{
  const input=anchor.current;if(!input||!visible)return;
  input.setAttribute('aria-controls',id);input.setAttribute('aria-expanded','true');
  if(count)input.setAttribute('aria-activedescendant',`${id}-${Math.min(active,count-1)}`);
  return()=>{if(input.getAttribute('aria-controls')===id){input.removeAttribute('aria-controls');input.removeAttribute('aria-expanded');input.removeAttribute('aria-activedescendant');}};
 },[anchor,visible,id,active,count]);
 function close(){setDismissed(prompt);setConfirmation(undefined);anchor.current?.focus();}
 async function apply(cmd:ComposerCommand,choice:CommandChoice,confirmed=false){
  if(saving.current||disabled)return;
  setError('');setDismissed(undefined);
  if(cmd.unavailable){setError(cmd.unavailable);return;}
  if(choice.confirmation&&!confirmed){setConfirmation({command:cmd,choice,prompt});return;}
  const draft=prompt;saving.current=true;setBusy(true);onBusy?.(true);setConfirmation(undefined);
  try {await cmd.apply?.(choice.value);if(live.current&&latest.current===draft){onPrompt('');onApplied();window.requestAnimationFrame?.(()=>{if(live.current)anchor.current?.focus();});}}
  catch(e){if(live.current&&latest.current===draft)setError(e instanceof Error?e.message:String(e));}
  finally{saving.current=false;if(live.current){setBusy(false);onBusy?.(false);}}
 }
 function select(cmd:ComposerCommand){
  if(disabled||saving.current)return;
  setError('');setDismissed(undefined);anchor.current?.focus();
  if(cmd.name==='help'){onPrompt('/');return;}
  if(cmd.choices){onPrompt(`/${cmd.name} `);return;}
  if(cmd.unavailable){setError(cmd.unavailable);return;}
  // Native actions still require explicit submission and retain their own safeguards.
  const next=`/${cmd.name} `;onPrompt(next);setDismissed(next);
 }
 function accept(){if(confirmation)return; if(choosing){const choice=choices[Math.min(active,choices.length-1)];if(choice)void apply(command!,choice);}else{const match=matches[Math.min(active,matches.length-1)];if(match)select(match);}}
 function submit(){
  if(!parsed)return false;
  if(saving.current||disabled)return true;
  if(parsed.name==='help'){onPrompt('/');setDismissed(undefined);return true;}
  if(choosing){
   setDismissed(undefined);
   if(confirmation)return true;
   if(command!.unavailable){setError(command!.unavailable!);return true;}
   if(!parsed.args){onPrompt(`/${command!.name} `);return true;}
   const choice=exactCommandChoice(command!.choices!,parsed.args);
   if(choice)void apply(command!,choice);else setError(t('请选择列出的有效选项；未发送聊天消息。'));
   return true;
  }
  if(!parsed.name||(!parsed.values&&!command&&matches.length)){setDismissed(undefined);if(matches.length===1)select(matches[0]);return true;}
  return false;
 }
 useImperativeHandle(ref,()=>({submit,keydown(event){
  if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return false;
  if(!visible)return false;
  if(!['ArrowDown','ArrowUp','Escape','Tab','Enter'].includes(event.key))return false;
  event.preventDefault();
  if(event.repeat)return true;
  if(event.key==='Escape'){close();return true;}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){if(count)setActive(n=>(n+(event.key==='ArrowDown'?1:count-1))%count);return true;}
  if(confirmation)return true;
  if(choosing&&!parsed?.values){select(command!);return true;}
  if(event.key==='Enter'&&choosing&&parsed?.args&&(!choices.length||exactCommandChoice(command!.choices!,parsed.args)))submit();else accept();
  return true;
 }}));
 if(!visible)return null;
 return <CompletionSurface anchor={anchor}><div ref={menu} className="slash-command-suggestions" role="group" aria-label={label}>
  <div className="slash-command-suggestions__header"><strong>{choosing?`/${command!.name} · ${command!.description}`:label}</strong><button type="button" aria-label={t('收起补全建议')} onMouseDown={e=>e.preventDefault()} onClick={close}><X size={16}/></button></div>
  <div className="slash-command-list" id={id} role="listbox" aria-label={choosing?command!.description:label} aria-busy={busy}>
   {confirmation?<div className="slash-command-confirm"><p>{confirmation.choice.label} · {confirmation.choice.confirmation}</p><button type="button" disabled={busy||disabled} onClick={()=>{const current=commands.find(c=>c.name===confirmation.command.name);const choice=current?.choices?.find(c=>c.value===confirmation.choice.value);if(confirmation.prompt===prompt&&current&&choice)void apply(current,choice,true);}}>{t('确认')}</button><button type="button" onClick={()=>setConfirmation(undefined)}>{t('取消')}</button></div>:
   choosing?choices.map((choice,index)=><button type="button" role="option" id={`${id}-${index}`} aria-selected={index===Math.min(active,count-1)} key={choice.value} data-current={choice.selected || undefined} disabled={busy||disabled||!!command!.unavailable} onMouseDown={e=>e.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>void apply(command!,choice)} title={choice.value}><span className="slash-command-choice-label">{choice.label}</span>{choice.selected&&<small className="slash-command-current"><Check size={14} aria-hidden="true"/>{t('当前')}</small>}</button>):
   matches.map((cmd,index)=><button type="button" role="option" id={`${id}-${index}`} aria-selected={index===Math.min(active,count-1)} key={cmd.name} disabled={busy||disabled} onMouseDown={e=>e.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>select(cmd)} title={[cmd.description,cmd.hint].filter(Boolean).join('\n')}><code>/{cmd.name}</code><span>{cmd.description}</span>{cmd.hint&&<small>{cmd.hint}</small>}</button>)}
   {choosing&&!choices.length&&!confirmation&&<p className="slash-command-suggestions__note">{t('没有匹配的选项')}</p>}
   {(error||command?.unavailable)&&<p className="slash-command-suggestions__note" role="alert">{systemText(error||command!.unavailable!)}</p>}
  </div>
  <p className="slash-command-suggestions__note" role="status">{busy?t('保存中…'):choosing?t('仅此会话 · 与“发送使用”同步 · 下次提交生效'):t('↑ ↓ 选择 · Tab / Enter 确认 · Esc 收起')}</p>
 </div></CompletionSurface>;
}
