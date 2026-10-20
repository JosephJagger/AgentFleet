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

/** These are panel-mapped controls, not a claim to expose every native CLI command. */
export function ClaudeCommandSuggestions({anchor,prompt,onSelect,supported}:{
  anchor:RefObject<HTMLTextAreaElement|null>; prompt:string; onSelect:(value:string)=>void; supported:boolean;
}){
  const commands:NativeCommand[]=[
    {name:"model",description:t("模型"),hint:"[host|sonnet|opus|haiku|claude-…]"},
    {name:"effort",description:t("思考强度"),hint:"[low|medium|high|xhigh|max]"},
    {name:"plan",description:t("计划模式")},
    {name:"help",description:t("命令清单与支持范围")},
  ];
  const text=prompt.trimStart();
  const matches=text.startsWith("/")&&!/\s/.test(text)?commands.filter(command=>command.name.startsWith(text.slice(1))):[];
  return <SlashCommandSuggestions anchor={anchor} prompt={prompt} commands={matches} label={t("Claude Code 命令")} note={supported?t("面板已接入的命令；点击填入，发送后执行。其他终端命令请在宿主机使用。"):t("Claude Code 原生控制需要 Agent 0.30.57 或更新版本")} onSelect={name=>onSelect(`/${name} `)}/>;
}
