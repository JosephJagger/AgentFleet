import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Settings2, ChevronRight, Lightbulb } from "lucide-react";
import type { ClaudeModel } from "../lib/types";
import type { ClaudeSettings } from "../lib/claude-preferences";
import { t } from "../i18n";

export function ClaudeControls({permissionModes,models,settings,ready,error,onReload,onSave,disabled,openRequest}:{permissionModes:string[];models:ClaudeModel[];settings:ClaudeSettings;ready:boolean;error:string;onReload:()=>void;onSave:(settings:ClaudeSettings)=>Promise<void>;disabled:boolean;openRequest:number}) {
  const [draft,setDraft]=useState(settings);
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState("");
  const model=draft.model,effort=draft.effort ?? "",permission=draft.permissionMode ?? "default",plan=draft.mode === "plan";
  const onModel=(model:string)=>setDraft(d=>({...d,model}));
  const onEffort=(effort:string)=>setDraft(d=>({...d,effort:effort || undefined}));
  const onPermission=(permission:string)=>setDraft(d=>({...d,permissionMode:permission as ClaudeSettings["permissionMode"]}));
  const onPlan=(plan:boolean)=>setDraft(d=>({...d,mode:plan?"plan":"default"}));
  const savedModel=models.find(m=>m.model===settings.model);
  disabled=disabled || !ready || saving;
  const [open,setOpen]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(open){setDraft(settings);setSaveError("");}},[open,ready]);
  useEffect(()=>{if(openRequest)setOpen(true);},[openRequest]);
  useEffect(()=>{if(open)dialog.current?.showModal?.();else dialog.current?.close?.();},[open]);
  const selected=models.find(m=>m.model===model);
  const permissionLabel=(value:string)=>t(value === "auto" ? "自动审核" : value === "acceptEdits" ? "自动接受编辑" : value === "dontAsk" ? "仅已允许工具" : "逐项确认");
  const autoSupported=(selected ?? models[0])?.supportsAutoMode === true;
  const efforts=selected?.efforts ?? (model==="host"?models[0]?.efforts:[]) ?? [];
  const controls=<>
    <label>{t("模型")}<select aria-label={t("Claude Code 模型")} value={model} onChange={e=>{onModel(e.target.value);onEffort("");if(permission === "auto" && e.target.value !== "host" && models.find(m=>m.model === e.target.value)?.supportsAutoMode !== true)onPermission("default");}} disabled={disabled}><option value="host">{t("继承宿主机")}</option>{models.map(m=><option key={m.model} value={m.model}>{m.displayName}</option>)}</select></label>
    <label>{t("思考强度")}<select aria-label={t("Claude Code 思考强度")} value={effort} onChange={e=>onEffort(e.target.value)} disabled={disabled || !efforts.length}><option value="">{t("继承宿主机")}</option>{efforts.map(e=><option key={e} value={e}>{e}</option>)}</select></label>
  </>;
  return <>
    <div className="runtime-settings-bar"><button type="button" className="runtime-settings-shortcut" aria-label={t("Claude Code 设置")} aria-haspopup="dialog" onClick={()=>setOpen(true)}><Settings2 size={13}/><span className="runtime-settings-lines"><span className="runtime-settings-line"><small>{t("发送使用")}</small><span>{!ready ? t(error || "正在读取会话配置…") : `Claude Code · ${savedModel?.displayName ?? (settings.model === "host" ? t("继承宿主机") : settings.model)} · ${settings.effort || t("继承强度")}${settings.permissionMode && settings.permissionMode !== "default" ? ` · ${permissionLabel(settings.permissionMode)}` : ""}`}</span></span></span><ChevronRight size={13}/></button>{settings.mode === "plan"&&<span className="runtime-mode-chip"><Lightbulb size={12}/><span>{t("计划模式")}</span><button type="button" disabled={disabled} aria-label={t("关闭计划模式")} onClick={()=>{void onSave({...settings,mode:"default"}).catch(e=>{setSaveError(e instanceof Error?e.message:String(e));setOpen(true);});}}><X size={12}/></button></span>}</div>

    {open&&createPortal(<dialog ref={dialog} className="claude-settings-dialog" aria-label={t("Claude Code 设置")} onCancel={()=>setOpen(false)} onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setOpen(false);}}>
      <div className="claude-settings-header"><div><h2>{t("Claude Code 设置")}</h2><p>{t("保存到该会话，后续轮次生效。")}</p></div><button type="button" className="button button--quiet" aria-label={t("关闭")} onClick={()=>setOpen(false)}><X size={20}/></button></div>
      <div className="claude-settings-fields">{controls}<label>{t("计划模式")}<select aria-label={t("Claude Code 计划模式")} value={plan?"plan":"default"} disabled={disabled} onChange={e=>onPlan(e.target.value==="plan")}><option value="default">{t("默认模式")}</option><option value="plan">{t("先分析并制定计划")}</option></select></label></div>
      <div className="claude-settings-fields"><label>{t("会话权限")}<select aria-label={t("Claude Code 权限模式")} value={permissionModes.includes(permission)?permission:"default"} disabled={disabled || !permissionModes.length} onChange={e=>onPermission(e.target.value)}><option value="default">{t("逐项确认")}</option>{permissionModes.filter(p=>p !== "default").map(p=><option key={p} value={p} disabled={p === "auto" && !autoSupported}>{permissionLabel(p)}{p === "auto" ? ` · ${t("推荐")}` : ""}</option>)}</select></label><small>{!permissionModes.length ? t("权限选择需要宿主机 Agent 更新及原生 Claude 支持。") : permission === "auto" ? t("由 Claude 自动审核工具操作；用户提问和部分敏感操作仍可能需要响应。") : permission === "acceptEdits" ? t("文件编辑自动接受，其他工具操作仍按原生规则确认。") : permission === "dontAsk" ? t("只执行已允许的工具，其余操作直接拒绝。") : t("需要权限的工具操作逐项确认。")}{permissionModes.length>0&&<><br/>{t("模型、思考强度、权限和计划模式一起保存。")}</>}{plan&&<><br/>{t("当前开启计划模式，本轮按原生计划权限运行。")}</>}</small></div>
      {!models.length&&<p role="status">{t("宿主机模型目录尚未返回；当前继承宿主机配置。")}</p>}
      {selected&&<small className="mono">{selected.model}</small>}
      {(error || saveError)&&<p role="alert">{t(error || saveError)} <button type="button" className="button button--quiet" onClick={()=>{onReload();setOpen(false);}}>{t("重新读取")}</button></p>}
      <div className="claude-settings-footer"><button type="button" className="button button--quiet" disabled={saving} onClick={()=>setOpen(false)}>{t("取消")}</button><button type="button" className="button button--primary" disabled={disabled} onClick={async()=>{setSaving(true);setSaveError("");try{await onSave(draft);setOpen(false);}catch(e){setSaveError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}}>{t(saving?"保存中…":"保存")}</button></div>
    </dialog>,document.body)}
  </>;
}
