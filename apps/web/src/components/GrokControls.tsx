import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Settings2, X } from "lucide-react";
import type { GrokModel, GrokConfigOption, GrokSettings, GrokPreferences } from "../lib/grok-preferences";
import { t } from "../i18n";

export function GrokControls({options,models=[],controls,observed,settings,ready,error,onReload,onSave,onEditingChange,disabled,allowStartup=false,xSearchSupported=false,openRequest=0}:{observed?:GrokPreferences["observed"];controls?:{planMode:boolean;permissionSync:boolean};models?:GrokModel[];options:GrokConfigOption[];settings:GrokSettings;ready:boolean;error:string;onReload:()=>void;onSave:(settings:GrokSettings)=>Promise<void>;onEditingChange?:(editing:boolean)=>void;disabled:boolean;allowStartup?:boolean;xSearchSupported?:boolean;openRequest?:number}) {
  const [draft,setDraft]=useState(settings);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);
  const dirty=useRef(false);
  const generation=useRef(0);
  const timer=useRef<number | undefined>(undefined);
  const draftRef=useRef(settings);
  useEffect(()=>{onEditingChange?.(dirty.current||saving);},[draft,saving,open,onEditingChange]);
  useEffect(()=>()=>{window.clearTimeout(timer.current);onEditingChange?.(false);},[onEditingChange]);
  draftRef.current=draft;
  const modelOption=options.find(option=>option.id==="model");
  const effortOption=options.find(option=>option.id==="reasoning_effort");
  const model=draft.model??"",effort=draft.effort??"",permission=draft.permissionMode??"",mode=draft.mode??"";
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
  const summary=!ready?t(error||"正在读取会话配置…"):`${settings.model||t("沿用原生")} · ${settings.effort||t("沿用原生")} · ${settings.permissionMode?permissionLabel(settings.permissionMode):t("沿用原生")}${settings.mode==="plan"?` · ${t("计划模式")}`:""}`;
  disabled=disabled||!ready||saving;
  return <>
    <div className="runtime-settings-bar"><button type="button" className="runtime-settings-shortcut" aria-label={t("Grok Build 设置")} aria-haspopup="dialog" onClick={()=>setOpen(true)}><Settings2 size={13}/><span className="runtime-settings-lines"><span className="runtime-settings-line"><small>{t("下一轮请求")}</small><span>{summary}</span></span></span><ChevronRight size={13}/></button></div>
    {open&&createPortal(<dialog ref={dialog} className="claude-settings-dialog" aria-label={t("Grok Build 设置")} onCancel={event=>{event.preventDefault();closeDialog();}} onClose={()=>setOpen(false)} onClick={event=>{if(event.target===event.currentTarget)closeDialog();}}>
      <div className="claude-settings-header"><div><h2>{t("Grok Build 设置")}</h2><p>{t("仅用于该会话，下一轮任务生效。可选项来自主机上的 Grok。")}</p></div><button type="button" className="button button--quiet" aria-label={t("关闭")} onClick={closeDialog}><X size={20}/></button></div>
      <div className="claude-settings-fields">
        <label>{t("模型")}<select aria-label={t("Grok Build 模型")} value={model} disabled={disabled} onChange={event=>{const model=event.target.value||undefined;const available=models.find(item=>item.id===model)?.efforts;edit({model,contextWindow:undefined,...(available&&draft.effort&&!available.includes(draft.effort)?{effort:undefined}:{})});}}><option value="">{t("沿用原生")}</option>{choices(model,modelOption?.values??[]).map(value=><option key={value} value={value}>{models.find(item=>item.id===value)?.name??value}</option>)}</select></label>
        <label>{t("思考强度")}<select aria-label={t("Grok Build 思考强度")} value={effort} disabled={disabled} onChange={event=>edit({effort:event.target.value||undefined})}><option value="">{t("沿用原生")}</option>{choices(effort,effortValues).map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        {!!selectedModel?.contextWindows?.length&&<label>{t("上下文窗口")}<select aria-label={t("上下文窗口")} value={draft.contextWindow??""} disabled={disabled} onChange={event=>edit({contextWindow:event.target.value?Number(event.target.value):undefined})}><option value="">{t("沿用原生")}</option>{selectedModel.contextWindows.map(n=><option key={n} value={n}>{n.toLocaleString()} tokens</option>)}</select></label>}
        <label>{t("任务模式")}<select aria-label={t("Grok Build 任务模式")} value={mode} disabled={disabled} onChange={event=>edit({mode:(event.target.value||undefined) as GrokSettings["mode"]})}><option value="">{t("沿用原生")}</option><option value="default" disabled={!controls?.planMode}>{t("默认模式")}</option><option value="plan" disabled={!controls?.planMode}>{t("计划模式")}</option></select></label>
      </div>
      {xSearchSupported&&<details className="config-disclosure"><summary>{t("X 搜索日期范围")}</summary><div className="claude-settings-fields"><p>{t("仅限制原生 X 搜索的日期范围，不会主动搜索。结束日期不包含当天，按 UTC 计算。")}</p>{(['fromDate','toDate'] as const).map(key=><label key={key}>{t(key==='fromDate'?'开始日期':'结束日期')}<input type="date" disabled={disabled} value={draft.xSearch?.[key]??""} onChange={e=>{const bounds={...draft.xSearch,[key]:e.target.value||undefined};edit({xSearch:bounds.fromDate||bounds.toDate?bounds:null});}}/></label>)}</div></details>}
      <details className="config-disclosure"><summary>{t("原生会话启动参数")}</summary><div className="claude-settings-fields"><p>{t("仅创建原生会话时应用。已有会话不可修改；重新接管不会覆盖原生提示词。")}</p>
        <label>{t("附加规则")}<textarea value={draft.rules??""} maxLength={8000} disabled={disabled||!allowStartup||!!draft.systemPromptOverride} onChange={e=>edit({rules:e.target.value||undefined})}/></label>
        <label>{t("替换系统提示词")}<textarea value={draft.systemPromptOverride??""} maxLength={8000} disabled={disabled||!allowStartup||!!draft.rules} onChange={e=>edit({systemPromptOverride:e.target.value||undefined})}/></label>
        <label>{t("原生智能体配置名称")}<input value={draft.agentProfile??""} maxLength={120} disabled={disabled||!allowStartup} onChange={e=>edit({agentProfile:e.target.value||undefined})}/></label>
      </div></details>
      {observed?.mode&&<p className="subtle">{t("上一轮原生任务模式")}：{t(observed.mode==='plan'?'计划模式':'默认模式')} · <time dateTime={observed.observedAt}>{new Date(observed.observedAt).toLocaleString()}</time></p>}
      {!controls?.planMode&&<p role="status">{t("当前主机未提供可验证的计划模式，请更新连接服务和 Grok。已保存的计划请求不会静默降级执行。")}</p>}
      {controls?.planMode&&<p className="subtle">{t("计划模式在下一轮通过原生接口切换。它限制原生编辑工具，不等同于只读沙箱。")}</p>}
      {!controls?.permissionSync&&<p role="status">{t("当前原生版本尚未验证权限同步，请沿用原生设置或更新 Grok。")}</p>}
      {!modelOption?.values.length&&<p role="status">{t("主机尚未返回模型列表，请更新连接服务后重新读取。")} <button type="button" className="button button--quiet" onClick={onReload}>{t("重新读取")}</button></p>}
      <div className="claude-settings-fields"><label>{t("会话权限")}<select aria-label={t("Grok Build 会话权限")} value={permission} disabled={disabled} onChange={event=>edit({permissionMode:(event.target.value||undefined) as GrokSettings["permissionMode"]})}><option value="">{t("沿用原生")}</option><option value="default" disabled={!controls?.permissionSync}>{t("逐项确认")}</option><option value="always">{t("始终允许")}</option><option value="auto" disabled={!controls?.permissionSync}>{t("自动审核")}</option></select></label>
        <small>{t("权限选择会在下一轮同步到原生会话。原生策略可能限制自动审核和始终允许；当前协议不返回最终权限状态。这里不是文件系统沙箱。")}</small>
      </div>
      {(error||saveError)&&<p role="alert">{t(error||saveError)} <button type="button" className="button button--quiet" onClick={()=>{onReload();setOpen(false);}}>{t("重新读取")}</button></p>}
      <div className="claude-settings-footer"><button type="button" className="button button--quiet" disabled={saving} onClick={discard}>{t("取消")}</button><button type="button" className="button button--primary" disabled={disabled} onClick={async()=>{window.clearTimeout(timer.current);const gen=++generation.current;if(await persist(draftRef.current,gen))setOpen(false);}}>{t(saving?"保存中…":"保存")}</button></div>
    </dialog>,document.body)}
  </>;
}
