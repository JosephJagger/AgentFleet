import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Settings2, ChevronRight, Lightbulb } from "lucide-react";
import type { ClaudeModel } from "../lib/types";
import type { ClaudeSettings } from "../lib/claude-preferences";
import { t } from "../i18n";

export function ClaudeControls({permissionModes,models,settings,ready,error,onReload,onSave,onEditingChange,disabled,openRequest}:{permissionModes:string[];models:ClaudeModel[];settings:ClaudeSettings;ready:boolean;error:string;onReload:()=>void;onSave:(settings:ClaudeSettings)=>Promise<void>;onEditingChange?:(editing:boolean)=>void;disabled:boolean;openRequest:number}) {
  const [draft,setDraft]=useState(settings);
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState("");
  const [open,setOpen]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const dirty=useRef(false);
  const generation=useRef(0);
  const timer=useRef<number | undefined>(undefined);
  const draftRef=useRef(settings);
  useEffect(()=>{onEditingChange?.(dirty.current||saving);},[draft,saving,open,onEditingChange]);
  useEffect(()=>()=>{window.clearTimeout(timer.current);onEditingChange?.(false);},[onEditingChange]);
  const model=draft.model,effort=draft.effort ?? "",permission=draft.permissionMode ?? "default",plan=draft.mode === "plan";
  const savedModel=models.find(m=>m.model===settings.model);
  disabled=disabled || !ready || saving;
  useEffect(()=>{if(open&&!dirty.current){draftRef.current=settings;setDraft(settings);setSaveError("");}},[open,ready,settings]);
  useEffect(()=>{if(openRequest)setOpen(true);},[openRequest]);
  useEffect(()=>{if(open)dialog.current?.showModal?.();else dialog.current?.close?.();},[open]);
  async function persist(next:ClaudeSettings,gen:number){
    setSaving(true);setSaveError("");
    try{await onSave(next);if(generation.current===gen)dirty.current=false;return true;}
    catch(e){setSaveError(e instanceof Error?e.message:String(e));setOpen(true);return false;}
    finally{setSaving(false);}
  }
  function edit(next:ClaudeSettings){
    draftRef.current=next;setDraft(next);dirty.current=true;
    const gen=++generation.current;window.clearTimeout(timer.current);
    timer.current=window.setTimeout(()=>{void persist(next,gen);},400);
  }
  function closeDialog(){window.clearTimeout(timer.current);if(dirty.current)void persist(draftRef.current,generation.current);setOpen(false);}
  function discard(){window.clearTimeout(timer.current);dirty.current=false;setDraft(settings);draftRef.current=settings;setOpen(false);}
  const selected=models.find(m=>m.model===model);
  const permissionLabel=(value:string)=>t(value === "auto" ? "自动审核" : value === "acceptEdits" ? "自动接受编辑" : value === "dontAsk" ? "仅已允许工具" : "逐项确认");
  const autoSupported=(selected ?? models[0])?.supportsAutoMode === true;
  const efforts=selected?.efforts ?? (model==="host"?models[0]?.efforts:[]) ?? [];
  const extraModels=[model,settings.model].filter((id,index,all)=>id!=="host"&&!models.some(item=>item.model===id)&&all.indexOf(id)===index);
  const knownPermissions=new Set(["default",...permissionModes]);
  const controls=<>
    <label>{t("模型")}<select aria-label={t("Claude Code 模型")} value={model} onChange={e=>{const nextModel=e.target.value;const nextPermission=permission==="auto"&&nextModel!=="host"&&models.find(m=>m.model===nextModel)?.supportsAutoMode!==true?"default":permission;edit({...draft,model:nextModel,effort:undefined,permissionMode:nextPermission});}} disabled={disabled}><option value="host">{t("继承宿主机")}</option>{extraModels.map(id=><option key={id} value={id}>{id}</option>)}{models.map(m=><option key={m.model} value={m.model}>{m.displayName}</option>)}</select></label>
    <label>{t("思考强度")}<select aria-label={t("Claude Code 思考强度")} value={effort} onChange={e=>edit({...draft,effort:e.target.value||undefined})} disabled={disabled || !efforts.length}><option value="">{t("继承宿主机")}</option>{effort&&!efforts.includes(effort)&&<option value={effort}>{effort}</option>}{efforts.map(e=><option key={e} value={e}>{e}</option>)}</select></label>
  </>;
  return <>
    <div className="runtime-settings-bar"><button type="button" className="runtime-settings-shortcut" aria-label={t("Claude Code 设置")} aria-haspopup="dialog" onClick={()=>setOpen(true)}><Settings2 size={13}/><span className="runtime-settings-lines"><span className="runtime-settings-line"><small>{t("发送使用")}</small><span>{!ready ? t(error || "正在读取会话配置…") : `${savedModel?.displayName ?? (settings.model === "host" ? t("继承宿主机") : settings.model)} · ${settings.effort || t("继承强度")} · ${settings.mode === "plan" ? t("计划批准后：{0}",permissionLabel(settings.permissionMode ?? "default")) : permissionLabel(settings.permissionMode ?? "default")}`}</span></span></span><ChevronRight size={13}/></button>{settings.mode === "plan"&&<span className="runtime-mode-chip"><Lightbulb size={12}/><span>{t("下次发送 · 计划模式")}</span><button type="button" disabled={disabled} aria-label={t("关闭计划模式")} onClick={()=>{void onSave({...settings,mode:"default"}).catch(e=>{setSaveError(e instanceof Error?e.message:String(e));setOpen(true);});}}><X size={12}/></button></span>}</div>

    {open&&createPortal(<dialog ref={dialog} className="claude-settings-dialog" aria-label={t("Claude Code 设置")} onCancel={event=>{event.preventDefault();closeDialog();}} onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)closeDialog();}}>
      <div className="claude-settings-header"><div><h2>{t("Claude Code 设置")}</h2><p>{t("保存到该会话，后续轮次生效。")}</p></div><button type="button" className="button button--quiet" aria-label={t("关闭")} onClick={closeDialog}><X size={20}/></button></div>
      <div className="claude-settings-fields">{controls}<label>{t("计划模式")}<select aria-label={t("Claude Code 计划模式")} value={plan?"plan":"default"} disabled={disabled} onChange={e=>edit({...draft,mode:e.target.value==="plan"?"plan":"default"})}><option value="default">{t("默认模式")}</option><option value="plan">{t("先分析并制定计划")}</option></select></label></div>
      <div className="claude-settings-fields"><label>{t("会话权限")}<select aria-label={t("Claude Code 权限模式")} value={permission} disabled={disabled || !permissionModes.length} onChange={e=>edit({...draft,permissionMode:e.target.value as ClaudeSettings["permissionMode"]})}><option value="default">{t("逐项确认")}</option>{!knownPermissions.has(permission)&&<option value={permission}>{permissionLabel(permission)}</option>}{permissionModes.filter(p=>p !== "default").map(p=><option key={p} value={p} disabled={p === "auto" && !autoSupported}>{permissionLabel(p)}{p === "auto" ? ` · ${t("推荐")}` : ""}</option>)}</select></label><small>{!permissionModes.length ? t("权限选择需要宿主机 Agent 更新及原生 Claude 支持。") : permission === "auto" ? t("由 Claude 自动审核工具操作；用户提问和部分敏感操作仍可能需要响应。") : permission === "acceptEdits" ? t("文件编辑自动接受，其他工具操作仍按原生规则确认。") : permission === "dontAsk" ? t("只执行已允许的工具，其余操作直接拒绝。") : t("需要权限的工具操作逐项确认。")}{permissionModes.length>0&&<><br/>{t("模型、思考强度、权限和计划模式一起保存。")}</>}{plan&&<><br/>{t("先分析并制定计划；批准计划后，按所选会话权限执行。保存的修改仅影响后续轮次。")}</>}</small></div>
      {!models.length&&<p role="status">{t("宿主机模型目录尚未返回；当前继承宿主机配置。")}</p>}
      {selected&&<small className="mono">{selected.model}</small>}
      {(error || saveError)&&<p role="alert">{t(error || saveError)} <button type="button" className="button button--quiet" onClick={()=>{onReload();setOpen(false);}}>{t("重新读取")}</button></p>}
      <div className="claude-settings-footer"><button type="button" className="button button--quiet" disabled={saving} onClick={discard}>{t("取消")}</button><button type="button" className="button button--primary" disabled={disabled} onClick={async()=>{window.clearTimeout(timer.current);const gen=++generation.current;if(await persist(draftRef.current,gen))setOpen(false);}}>{t(saving?"保存中…":"保存")}</button></div>
    </dialog>,document.body)}
  </>;
}
