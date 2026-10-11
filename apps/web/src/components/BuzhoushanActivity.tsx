import { isConversationEvent } from "../lib/buzhoushan-events";
import { timelineItems } from "../lib/timeline-items";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Terminal, RotateCcw } from "lucide-react";
import { useSessionProgress } from "./RuntimeProgress";
import type { SessionDetail, SessionProgress } from "../lib/types";
import { t } from "../i18n";

type ActivityItem = SessionProgress["items"][number];
const HEIGHT_KEY = "agentfleet.buzhoushan.dock-height";
const clamp = (n: number) => Math.max(130, Math.min(360, window.innerHeight * .36, n));

export function workbenchItems(detail: SessionDetail, progress?: SessionProgress): ActivityItem[] {
  const matching = progress?.sessionId === detail.session.id && (!detail.session.activeTurnId || progress.nativeTurnId === detail.session.activeTurnId) ? progress : undefined;
  if (matching?.contentAvailable === false) return [];
  const turn = detail.session.activeTurnId || matching?.nativeTurnId || [...detail.events].reverse().find(event=>event.nativeTurnId)?.nativeTurnId;
  const hidden = new Set(detail.events.filter(event=>event.payloadState === "deleted" || event.payloadState === "suppressed").map(event=>event.nativeItemId || event.id));
  const items = new Map<string,ActivityItem>();
  for (const event of timelineItems(detail.events)) {
    const id = event.nativeItemId || event.id;
    if (hidden.has(id) || (turn && event.nativeTurnId && event.nativeTurnId !== turn) || isConversationEvent(event) || event.itemType === "fileChange" || event.diff || event.fileChanges?.length) continue;
    items.set(id,{id,kind:event.command?"commandExecution":event.itemType || "process",status:event.status || (event.type==="item.completed"?"completed":"unknown"),
      title:event.command || event.title || event.type,
      output:event.output || event.body || undefined,updatedAt:event.occurredAt});
  }
  for (const item of matching?.items ?? []) if (!hidden.has(item.id) && item.kind === "commandExecution") items.set(item.id,item);
  return [...items.values()].slice(-60);
}

export function BuzhoushanActivity({detail, conversation}: {detail: SessionDetail; conversation?: ReactNode}) {
  const active = Boolean(detail.session.activeTurnId) || detail.session.state.currentTurn === "in_progress" || detail.session.state.unknownFreeze;
  const {progress, unavailable} = useSessionProgress(detail.session.id, active && detail.session.provider !== "claude", detail.progress, true);
  const scoped = progress && (!detail.session.activeTurnId || progress.nativeTurnId === detail.session.activeTurnId) ? progress : undefined;
  const items = workbenchItems(detail, scoped);
  const [tab,setTab] = useState<"commandExecution"|"conversation">("commandExecution");
  const [following,setFollowing] = useState(true);
  const [selected,setSelected] = useState<string>();
  const [collapsed,setCollapsed] = useState(true);
  const [height,setHeight] = useState(() => {try { const n=Number(localStorage.getItem(HEIGHT_KEY));return clamp(n>0?n:220); } catch {return clamp(220);} });
  const output = useRef<HTMLPreElement>(null);
  const drag = useRef<{y:number;height:number} | undefined>(undefined);
  const visible = items;
  const itemTitle=(item:ActivityItem)=>item.title;
  const current = following ? visible.at(-1) : visible.find(item=>item.id===selected);
  useEffect(() => { if (following && output.current) output.current.scrollTop = output.current.scrollHeight; }, [following,current?.id,current?.output,collapsed]);
  const isLive = active && scoped?.freshness === "live" && !unavailable && detail.hostOnline !== false;
  const status = unavailable ? t("进度暂时无法更新") : isLive ? t("实时更新") : t("最后已知进度");
  useEffect(()=>{const resize=()=>setHeight(h=>clamp(h));window.addEventListener("resize",resize);return()=>window.removeEventListener("resize",resize);},[]);
  useEffect(()=>{try{localStorage.setItem(HEIGHT_KEY,String(height));}catch{/* Local preference is optional. */}},[height]);
  const reset=()=>{setHeight(clamp(220));setFollowing(true);setTab("commandExecution");};
  const stateLabel=(value:string)=>({completed:t("已完成"),failed:t("失败"),declined:t("已拒绝"),running:t("执行中"),in_progress:t("执行中")}[value] || t("状态待确认"));
  return <section className={`buzhou-dock${collapsed?" buzhou-dock--collapsed":""}`} aria-label={t("代码活动")} style={{height:collapsed?38:height}}>
    {!collapsed && <div className="buzhou-resizer" role="separator" aria-label={t("调整代码活动高度")} aria-orientation="horizontal" aria-valuemin={130} aria-valuemax={Math.floor(Math.min(360,window.innerHeight*.36))} aria-valuenow={Math.round(height)} tabIndex={0}
      onPointerDown={event=>{if(event.button!==0)return;drag.current={y:event.clientY,height};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(drag.current)setHeight(clamp(drag.current.height+drag.current.y-event.clientY));}}
      onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}} onLostPointerCapture={()=>{drag.current=undefined;}}
      onKeyDown={event=>{if(event.key==="ArrowUp"||event.key==="ArrowDown"){event.preventDefault();setHeight(h=>clamp(h+(event.key==="ArrowUp"?20:-20)));}}}/>} 
    <header className="buzhou-dock__head" onClick={event=>{if (!(event.target as HTMLElement).closest("button")) setCollapsed(false);}}>
      <div className="buzhou-dock__tabs" role="group" aria-label={t("活动筛选")}>
        {([["commandExecution","终端"],["conversation","人机对话"]] as const).map(([value,label])=><button type="button" aria-pressed={tab===value} key={value} onClick={()=>{setTab(value);setFollowing(true);setCollapsed(false);}}>{t(label)}</button>)}
      </div>
      <small>{status}</small>
      <button type="button" onClick={reset} title={t("重置活动布局")} aria-label={t("重置活动布局")}><RotateCcw size={14}/></button>
      <button type="button" onClick={()=>setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed?t("展开代码活动"):t("收起代码活动")}>{collapsed?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button>
    </header>
    {!collapsed && tab === "conversation" && <div className="buzhou-dock__chat">{conversation ?? <p>{t("暂无对话消息")}</p>}</div>}
    {!collapsed && tab === "commandExecution" && <div className="buzhou-dock__body">
      <div className="buzhou-dock__list" aria-label={t("最近活动")}>
        {[...visible].reverse().map(item=><button type="button" key={item.id} aria-pressed={current?.id===item.id} onClick={()=>{setSelected(item.id);setFollowing(false);}}>
          <Terminal size={15}/><span><strong>{itemTitle(item).slice(0,240)}</strong><small>{stateLabel(item.status)}</small></span>
        </button>)}
        {!visible.length&&<p>{scoped?.contentAvailable===false?t("未开启内容同步，仅显示运行状态"):t("尚无可展示的代码活动")}</p>}
      </div>
      <div className="buzhou-dock__output">
        <div className="buzhou-dock__caption"><span>{current ? stateLabel(current.status) : t("等待过程事件")}{current?.updatedAt&&` · ${new Date(current.updatedAt).toLocaleTimeString()}`}</span><button type="button" aria-pressed={following} onClick={()=>setFollowing(!following)}>{following?t("跟随最新"):t("查看最新活动")}</button></div>
        {current?<pre key={current.id} ref={output} onWheel={event=>{if(event.deltaY<0){setSelected(current.id);setFollowing(false);}}}><code>{itemTitle(current).slice(0,4000)}{"\n\n"}{current.output?.slice(-16000)||t("暂无输出正文；完整内容见会话记录")}</code></pre>:<p>{!following?t("所选活动已离开最近记录，可查看最新活动"):t("任务执行时，在这里查看命令与推理摘要")}</p>}
        <small className="buzhou-dock__limit">{t("最近 60 条活动 · 输出最多 16000 字符 · 完整记录见会话")}</small>
      </div>
    </div>}
  </section>;
}
