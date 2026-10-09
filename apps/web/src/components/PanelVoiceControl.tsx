import {VoiceTaskInbox} from "./VoiceTaskInbox";
import { ProgressView } from "./RuntimeProgress";
import { useDraggablePanel } from "../lib/use-draggable-panel";
import { useState, useRef, useId } from "react";
import { createPortal } from "react-dom";
import { Headset, X, ExternalLink, Activity, ChevronDown } from "lucide-react";
import { NativeVoicePanel, type PanelVoiceTask } from "./NativeVoicePanel";
import { t } from "../i18n";
import type { Dashboard } from "../lib/types";

export function PanelVoiceControl({ machines, onOpenSession }: { machines:Dashboard['machines'];onOpenSession:(id:string)=>void }) {
  const [expanded,setExpanded]=useState(false);
  const panel = useRef<HTMLElement>(null);
  const dragging = useDraggablePanel(panel, expanded);
  const [host,setHost]=useState('');
  const [active,setActive]=useState(false);
  const [tasks,setTasks]=useState<PanelVoiceTask[]>([]);
  const [tasksExpanded,setTasksExpanded]=useState(false);
  const taskListId=useId();
  const runningCount=tasks.filter(task=>task.state==='running').length;
  const pendingCount=tasks.filter(task=>task.state==='submitted').length;
  const unknownCount=tasks.filter(task=>task.state==='unknown').length;
  const eligible=machines.filter(m=>{const v=m.agentVersion.split('.').map(Number);return m.reachability==='live'&&(v[0]>0||v[1]>30||v[1]===30&&v[2]>=69);});
  const selected=host||eligible[0]?.id||'';
  const selectedVersion=eligible.find(machine=>machine.id===selected)?.agentVersion.split('.').map(Number);
  const supportsMemory=selectedVersion&&(selectedVersion[0]>0||selectedVersion[1]>30||selectedVersion[1]===30&&selectedVersion[2]>=87);
  const supportsParallel=selectedVersion&&(selectedVersion[0]>0||selectedVersion[1]>30||selectedVersion[1]===30&&selectedVersion[2]>=86);
  return <div className="panel-voice-control">
    <button className={`button button--secondary${active?' panel-voice-control--active':''}`} type="button" aria-label={t("面板语音总控")} aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><Headset size={18}/><span>{t("语音总控")}</span>{active&&<i aria-hidden="true"/>}</button>
    {createPortal(<>
    {active&&<button type="button" className="button button--secondary panel-voice-control__floating" onClick={()=>setExpanded(true)} aria-label={t("面板语音总控")}><Headset size={16}/>{t("总控通话控制")}</button>}
    <section ref={panel} style={dragging.style} className="panel-voice-control__settings" hidden={!expanded} aria-label={t("面板语音总控")}>
      <header className="voice-drag-handle" {...dragging.handle}><strong className="panel-voice-control__title"><Headset size={22}/>{t("语音总控")}</strong><button className="icon-button" aria-label={t("关闭")} onClick={()=>setExpanded(false)}><X size={17}/></button></header>
      <p>{t("说出主机、项目和任务，不同项目可并行派发。")}</p>
      <label>{t("语音主机")}<select value={selected} disabled={active||!eligible.length} onChange={e=>setHost(e.target.value)}>{!eligible.length&&<option value="">{t("等待支持总控的主机上线")}</option>}{eligible.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <p className="panel-voice-control__hint">{t("使用此主机的 Codex 账号通话，可指挥其他主机。")}</p>
      {eligible.find(m=>m.id===selected)?.maintenance && <p role="status">{t("主机正在维护，等待安全重启；当前任务可继续，暂不接受新任务")}</p>}
      {!supportsParallel&&selected&&<p role="status">{t("并行派发需要语音主机连接服务 0.30.86 或更新版本；更新后请重新通话")}</p>}
      <NativeVoicePanel sessionId={`panel:${selected}`} globalMachineId={selected||'unavailable'} canStart={Boolean(selected&&eligible.some(m=>m.id===selected&&!m.maintenance))} onActiveChange={value=>{if(value)setHost(selected);setActive(value);}} onPanelTasks={setTasks} onPanelTask={task=>{if(!task)setTasks([]);else setTasks(previous=>[task,...previous.filter(other=>other.jobId!==task.jobId)]);}}/>
      {!supportsMemory&&selected&&<p>{t("服务端待办恢复需要语音主机 0.30.87 或更新版本，更新后重新通话")}</p>}
      <button type="button" className="panel-voice-control__task-summary" aria-expanded={tasksExpanded} aria-controls={taskListId} onClick={()=>setTasksExpanded(value=>!value)}>
        <strong>{runningCount}</strong><span>{t("运行中")}</span><Activity size={18}/><ChevronDown size={16} className={tasksExpanded?'is-expanded':''}/>
      </button>
      {(pendingCount>0||unknownCount>0)&&<p className="panel-voice-control__hint">{pendingCount>0&&<span>{t("等待主机")} {pendingCount} </span>}{unknownCount>0&&<span>{t("状态待确认")} {unknownCount}</span>}</p>}
      <div id={taskListId} className="panel-voice-control__task-list" hidden={!tasksExpanded}>
      {!tasks.length&&<p>{t("暂无本次通话派发的任务")}</p>}
      {tasks.map(task=><div key={task.jobId} className="panel-voice-control__task"><button type="button" className="panel-voice-control__task-target" onClick={()=>onOpenSession(task.sessionId)}><span><strong>{task.title}</strong><small>{task.host} · {task.project}</small></span><ExternalLink size={16}/></button><span>{task.state==='submitted'?t("等待主机"):task.state==='running'?t("执行中"):task.state==='completed'?t("已完成"):task.state==='failed'?t("失败"):task.state==='interrupted'?t("已停止"):t("状态待确认")}</span><details className="panel-voice-control__task-detail"><summary>{t("任务详情")}</summary>{task.progress&&["submitted","running","unknown"].includes(task.state)&&<ProgressView progress={task.progress}/>} {task.error&&<p role="alert">{task.error.code === 'MACHINE_DRAINING' ? t("主机正在维护，等待安全重启；当前任务可继续，暂不接受新任务") : task.error.message}<br/><code>{task.error.code}</code></p>}{(task.state==='failed'||task.state==='interrupted'||task.state==='unknown')&&<span>{task.executionStarted===true?t("任务已启动"):task.executionStarted===false?t("任务未启动"):t("任务是否启动尚未确认，请勿重复派发")}</span>}{task.historyLimited&&<span>{t("部分任务历史不可用")}</span>}{task.result&&<details><summary>{t("任务结果")}</summary><p>{task.result}</p></details>}</details></div>)}
      </div>
      {expanded&&<VoiceTaskInbox onOpenSession={onOpenSession}/>}
      <p className="panel-voice-control__hint panel-voice-control__footer">{t("切换页面、标签或收起面板可继续通话；请保留通话网页。刷新、关闭或系统休眠可能中断，已派发任务继续执行。")}</p>
    </section>
    </>,document.body)}
  </div>;
}
