import { useState } from "react";
import { createPortal } from "react-dom";
import { Globe2, X, ExternalLink } from "lucide-react";
import { NativeVoicePanel, type PanelVoiceTask } from "./NativeVoicePanel";
import { t } from "../i18n";
import type { Dashboard } from "../lib/types";

export function PanelVoiceControl({ machines, onOpenSession }: { machines:Dashboard['machines'];onOpenSession:(id:string)=>void }) {
  const [expanded,setExpanded]=useState(false);
  const [host,setHost]=useState('');
  const [active,setActive]=useState(false);
  const [task,setTask]=useState<PanelVoiceTask>();
  const eligible=machines.filter(m=>{const v=m.agentVersion.split('.').map(Number);return m.reachability==='live'&&(v[0]>0||v[1]>30||v[1]===30&&v[2]>=69);});
  const selected=host||eligible[0]?.id||'';
  return <div className="panel-voice-control">
    <button className={`button button--secondary${active?' panel-voice-control--active':''}`} type="button" aria-label={t("面板语音总控")} aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><Globe2 size={18}/><span>{t("总控")}</span>{active&&<i aria-hidden="true"/>}</button>
    {createPortal(<>
    {active&&<button type="button" className="button button--secondary panel-voice-control__floating" onClick={()=>setExpanded(true)} aria-label={t("面板语音总控")}><Globe2 size={16}/>{t("总控通话控制")}</button>}
    <section className="panel-voice-control__settings" hidden={!expanded} aria-label={t("面板语音总控")}>
      <header><strong>{t("面板语音总控")}</strong><button className="icon-button" aria-label={t("关闭")} onClick={()=>setExpanded(false)}><X size={17}/></button></header>
      <p>{t("一通电话跨主机派发任务，一次跟进一个；切换页面不断线。")}</p>
      <label>{t("语音主机")}<select value={selected} disabled={active||!eligible.length} onChange={e=>setHost(e.target.value)}>{!eligible.length&&<option value="">{t("等待支持总控的主机上线")}</option>}{eligible.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <p className="panel-voice-control__hint">{t("使用所选主机的 Codex 登录账号。说出目标主机、项目和会话；原有会话电话仍可单独使用。")}</p>
      <NativeVoicePanel sessionId={`panel:${selected}`} globalMachineId={selected||'unavailable'} canStart={Boolean(selected&&eligible.some(m=>m.id===selected))} onActiveChange={value=>{if(value)setHost(selected);setActive(value);}} onPanelTask={setTask}/>
      {task&&<div className="panel-voice-control__task"><strong>{task.title}</strong><span>{task.host} · {task.project}</span><span>{task.state==='submitted'?t("等待主机"):task.state==='running'?t("执行中"):task.state==='completed'?t("已完成"):task.state==='failed'?t("失败"):task.state==='interrupted'?t("已停止"):t("状态待确认")}</span><button className="button button--secondary" onClick={()=>onOpenSession(task.sessionId)}><ExternalLink size={14}/>{t("打开目标会话")}</button>{task.result&&<details><summary>{t("任务结果")}</summary><p>{task.result}</p></details>}</div>}
      <p className="panel-voice-control__hint">{t("挂断不取消已派发任务；关闭网页或浏览器进入后台会结束通话。")}</p>
    </section>
    </>,document.body)}
  </div>;
}
