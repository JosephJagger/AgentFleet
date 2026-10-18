import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Settings2, X } from "lucide-react";
import type { GrokModel, GrokConfigOption, GrokSettings } from "../lib/grok-preferences";
import { t } from "../i18n";

export function GrokControls({options,models=[],settings,ready,error,onReload,onSave,disabled,openRequest=0}:{models?:GrokModel[];options:GrokConfigOption[];settings:GrokSettings;ready:boolean;error:string;onReload:()=>void;onSave:(settings:GrokSettings)=>Promise<void>;disabled:boolean;openRequest?:number}) {
  const [draft,setDraft]=useState(settings);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);
  const dirty=useRef(false);
  const generation=useRef(0);
  const timer=useRef<number | undefined>(undefined);
  const draftRef=useRef(settings);
  draftRef.current=draft;
  const modelOption=options.find(option=>option.id==="model");
  const effortOption=options.find(option=>option.id==="reasoning_effort");
  const modeOption=options.find(option=>option.id==="plan"||option.id==="mode"||option.id==="task");
  const model=draft.model??"",effort=draft.effort??"",permission=draft.permissionMode??"default",mode=draft.mode??"default";
  useEffect(()=>{if(open&&!dirty.current){draftRef.current=settings;setDraft(settings);setSaveError("");}},[open,ready,settings]);
  useEffect(()=>{if(openRequest)setOpen(true);},[openRequest]);
  useEffect(()=>{if(open)dialog.current?.showModal?.();else dialog.current?.close?.();},[open]);
  async function persist(next:GrokSettings,gen:number){
    setSaving(true);setSaveError("");
    try{await onSave(next);if(generation.current===gen)dirty.current=false;return true;}
    catch(e){setSaveError(e instanceof Error?e.message:String(e));setOpen(true);return false;}
    finally{setSaving(false);}
  }
  function edit(patch:Partial<GrokSettings>){
    const next={...draftRef.current,...patch};
    draftRef.current=next;setDraft(next);dirty.current=true;
    const gen=++generation.current;window.clearTimeout(timer.current);
    timer.current=window.setTimeout(()=>{void persist(next,gen);},400);
  }
  function closeDialog(){
    window.clearTimeout(timer.current);
    if(dirty.current)void persist(draftRef.current,generation.current);
    setOpen(false);
  }
  function discard(){window.clearTimeout(timer.current);dirty.current=false;setDraft(settings);draftRef.current=settings;setOpen(false);}
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  const selectedModel=models.find(item=>item.id===(model||modelOption?.current));
  const effortValues=selectedModel?.efforts??effortOption?.values??[];
  const permissionLabel=(value:string)=>t(value==="always"?"始终允许":value==="auto"?"自动审核":"逐项确认");
  const choices=(current:string,values:string[])=>current&&!values.includes(current)?[current,...values]:values;
  const summary=!ready?t(error||"正在读取会话配置…"):`${settings.model||t("沿用原生")} · ${settings.effort||t("沿用原生")} · ${permissionLabel(settings.permissionMode??"default")}${settings.mode==="plan"?` · ${t("计划模式")}`:""}`;
  disabled=disabled||!ready||saving;
  return <>
    <div className="runtime-settings-bar"><button type="button" className="runtime-settings-shortcut" aria-label={t("Grok Build 设置")} aria-haspopup="dialog" onClick={()=>setOpen(true)}><Settings2 size={13}/><span className="runtime-settings-lines"><span className="runtime-settings-line"><small>{t("发送使用")}</small><span>{summary}</span></span></span><ChevronRight size={13}/></button></div>
    {open&&createPortal(<dialog ref={dialog} className="claude-settings-dialog" aria-label={t("Grok Build 设置")} onCancel={event=>{event.preventDefault();closeDialog();}} onClose={()=>setOpen(false)} onClick={event=>{if(event.target===event.currentTarget)closeDialog();}}>
      <div className="claude-settings-header"><div><h2>{t("Grok Build 设置")}</h2><p>{t("仅用于该会话，下一轮任务生效。可选项来自主机上的 Grok。")}</p></div><button type="button" className="button button--quiet" aria-label={t("关闭")} onClick={closeDialog}><X size={20}/></button></div>
      <div className="claude-settings-fields">
        <label>{t("模型")}<select aria-label={t("Grok Build 模型")} value={model} disabled={disabled} onChange={event=>{const model=event.target.value||undefined;const available=models.find(item=>item.id===model)?.efforts;edit({model,...(available&&draft.effort&&!available.includes(draft.effort)?{effort:undefined}:{})});}}><option value="">{t("沿用原生")}</option>{choices(model,modelOption?.values??[]).map(value=><option key={value} value={value}>{models.find(item=>item.id===value)?.name??value}</option>)}</select></label>
        <label>{t("思考强度")}<select aria-label={t("Grok Build 思考强度")} value={effort} disabled={disabled} onChange={event=>edit({effort:event.target.value||undefined})}><option value="">{t("沿用原生")}</option>{choices(effort,effortValues).map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <label>{t("任务模式")}<select aria-label={t("Grok Build 任务模式")} value={mode} disabled={disabled} onChange={event=>edit({mode:event.target.value==="plan"?"plan":"default"})}><option value="default">{t("默认模式")}</option><option value="plan">{t("计划模式")}</option></select></label>
      </div>
      {!modelOption?.values.length&&<p role="status">{t("主机尚未返回模型列表，请更新连接服务后重新读取。")} <button type="button" className="button button--quiet" onClick={onReload}>{t("重新读取")}</button></p>}
      <div className="claude-settings-fields"><label>{t("会话权限")}<select aria-label={t("Grok Build 会话权限")} value={permission} disabled={disabled} onChange={event=>edit({permissionMode:event.target.value as GrokSettings["permissionMode"]})}><option value="default">{t("逐项确认")}</option><option value="always">{t("始终允许")}</option><option value="auto">{t("自动审核")}</option></select></label>
        <small>{t("这里控制工具审批，不是文件夹沙箱。始终允许会在下一轮重连进程并放行工具。自动审核只在新建原生会话时生效。")}{mode==="plan"&&!modeOption?.values.includes("plan")?` ${t("计划模式已保存；当前原生会话没有对应选项时不会下发。")}`:""}</small>
      </div>
      {(error||saveError)&&<p role="alert">{t(error||saveError)} <button type="button" className="button button--quiet" onClick={()=>{onReload();setOpen(false);}}>{t("重新读取")}</button></p>}
      <div className="claude-settings-footer"><button type="button" className="button button--quiet" disabled={saving} onClick={discard}>{t("取消")}</button><button type="button" className="button button--primary" disabled={disabled} onClick={async()=>{window.clearTimeout(timer.current);const gen=++generation.current;if(await persist(draftRef.current,gen))setOpen(false);}}>{t(saving?"保存中…":"保存")}</button></div>
    </dialog>,document.body)}
  </>;
}
