import {useEffect, useRef, useState, type RefObject} from "react";
import {X} from "lucide-react";
import {CompletionSurface} from "./CompletionSurface";
import {t} from "../i18n";
import {codexCommands,coverageLabels} from "../lib/codex-commands";
import "./slash-command-suggestions.css";

interface NativeCommand {name:string; description:string; hint?:string}

/** Native suggestions float above the composer; neither descriptions nor hints size its layout. */
function SlashCommandSuggestions({anchor,prompt,commands,onSelect,label,note}:{
  anchor:RefObject<HTMLTextAreaElement|null>; prompt:string; commands:NativeCommand[];
  onSelect:(name:string)=>void; label:string; note?:string;
}){
  const [dismissed,setDismissed]=useState(false);
  const menu=useRef<HTMLDivElement>(null);
  const visible=!dismissed&&commands.length>0;
  useEffect(()=>setDismissed(false),[prompt]);
  useEffect(()=>{
    if(!visible)return;
    const input=anchor.current;
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();setDismissed(true);}};
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&event.target!==input&&!menu.current?.contains(event.target))setDismissed(true);};
    input?.addEventListener("keydown",escape);
    document.addEventListener("pointerdown",outside);
    return()=>{input?.removeEventListener("keydown",escape);document.removeEventListener("pointerdown",outside);};
  },[anchor,visible]);
  if(!visible)return null;
  return <CompletionSurface anchor={anchor}><div ref={menu} className="slash-command-suggestions" role="group" aria-label={label}>
    <div className="slash-command-suggestions__header"><strong>{label}</strong><button type="button" aria-label={t("收起补全建议")} onMouseDown={e=>e.preventDefault()} onClick={()=>{setDismissed(true);anchor.current?.focus();}}><X size={16}/></button></div>
    {note&&<p className="slash-command-suggestions__note">{note}</p>}
    <div className="slash-command-list">{commands.map(command=><button type="button" key={command.name} onMouseDown={e=>e.preventDefault()} onClick={()=>{setDismissed(true);anchor.current?.focus();onSelect(command.name);}} title={[command.description,command.hint].filter(Boolean).join("\n")}>
      <code>/{command.name}</code><span>{command.description}</span>{command.hint&&<small>{command.hint}</small>}
    </button>)}</div>
  </div></CompletionSurface>;
}

export function GrokCommandSuggestions({anchor,prompt,commands,onSelect}:{
  anchor:RefObject<HTMLTextAreaElement|null>; prompt:string; commands:NativeCommand[];
  onSelect:(value:string)=>void;
}){
  const matches=prompt.startsWith("/")&&!/\s/.test(prompt)?commands.filter(c=>c.name.startsWith(prompt.slice(1))):[];
  return <SlashCommandSuggestions anchor={anchor} prompt={prompt} commands={matches} label={t("Grok 原生命令")} onSelect={name=>onSelect(`/${name} `)}/>;
}

export function CodexCommandSuggestions({anchor,prompt,onSelect}:{
  anchor:RefObject<HTMLTextAreaElement|null>; prompt:string; onSelect:(name:string)=>void;
}){
  const matches=prompt.trimStart().startsWith("/")?codexCommands.filter(item=>item.name.includes(prompt.trim().slice(1).split(/\s/)[0].toLowerCase())).map(item=>({name:item.name,description:`${item.label} · ${coverageLabels[item.coverage]}`})):[];
  return <SlashCommandSuggestions anchor={anchor} prompt={prompt} commands={matches} label={t("Codex 命令")} note={t("面板命令 · 点击待接入项可查看原因，不会发送给模型")} onSelect={onSelect}/>;
}
