import { sessionPath } from "../lib/session-workspace";
import { useEffect, useRef, useState } from 'react';
import { Globe, Users, X, Hand, Play, RefreshCw, Plus, ArrowUpRight } from 'lucide-react';
import { api, collaborationApi } from '../lib/api';
import type { FleetSession } from '../lib/types';
import type { BrowserFrame, CollaborationPlan, TaskDraft } from '../lib/collaboration';
import { taskState, readPlanDraft } from '../lib/collaboration';
import { displayName } from '../lib/display-name';
import { t } from '../i18n';

export function CollaborationWorkspace({session,tab,onTab,onClose}:{session:FleetSession;tab:'browser'|'tasks';onTab:(tab:'browser'|'tasks')=>void;onClose:()=>void}) {
  return <section className="collaboration-workspace" aria-label={t('协作工作区')}>
    <header className="collaboration-tabs"><button type="button" aria-pressed={tab==='browser'} onClick={()=>onTab('browser')}><Globe size={16}/>{t('浏览器协作')}</button><button type="button" aria-pressed={tab==='tasks'} onClick={()=>onTab('tasks')}><Users size={16}/>{t('分工处理')}</button><button type="button" className="collaboration-close" aria-label={t('收起协作工作区')} onClick={onClose}><X size={17}/></button></header>
    <div className="collaboration-location">{t('当前会话')} · {displayName(session.title)}</div>
    {tab==='browser'?<SharedBrowser key={session.id} session={session}/>:<TaskBoard key={session.id} session={session}/>}
  </section>;
}
export function SharedBrowser({session}:{session:FleetSession}) {
  const [frame,setFrame]=useState<BrowserFrame|null>(null),[opened,setOpened]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState('https://'),[input,setInput]=useState('');
  const sequence=useRef(0),alive=useRef(true),operation=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  async function refresh(signal?:AbortSignal){const n=++sequence.current;const value=await collaborationApi.browser(session.id,{action:'snapshot'},signal);if(alive.current&&n===sequence.current&&!signal?.aborted)setFrame(value);}
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{if(!operation.current)await refresh(controller.signal);}catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{if(!controller.signal.aborted)timer=setTimeout(poll,2000);}};
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[opened,session.id]);
  async function act(action:string,extra:Record<string,unknown>={}){
    if(operation.current)return;operation.current=true;setBusy(true);setError('');sequence.current++;
    try{
      const value=await collaborationApi.browser(session.id,{action,key:crypto.randomUUID(),revision:frame?.revision,...extra});
      if(!alive.current)return;
      if(action==='close'){setFrame(null);setOpened(false);return;}
      if(action==='open'){setOpened(true);setFrame(value);}
      else await refresh();
      return true;
    }catch(e){if(alive.current)setError((e as Error).message);}finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  return <div className="collaboration-browser">
    <p className="collaboration-location">{t('浏览器位于')}：<strong>{displayName(session.machineName??'')}</strong></p>
    {!opened?<div className="collaboration-welcome"><Globe size={34}/><h3>{t('一起看网页，一起把事情做完')}</h3><p>{t('打开独立浏览器，页面会显示在这里。它不读取你现有的浏览器登录状态。登录时由你接手，AI 操作前会等待你确认。')}</p><button type="button" className="button button--primary" disabled={busy||session.state.ownership!=='agentfleet_owned'} onClick={()=>void act('open')}>{busy?t('正在打开…'):t('打开浏览器协作')}</button><small>{t('需要主机安装新版连接服务及 Chrome、Edge 或 Chromium。打开后，从下一轮对话开始使用。')}</small></div>:<>
      <form className="collaboration-address" onSubmit={e=>{e.preventDefault();void act('navigate',{url});}}><label className="sr-only" htmlFor="collaboration-url">{t('网页地址')}</label><input id="collaboration-url" type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com" disabled={busy||frame?.mode!=='human'}/><button type="submit" disabled={busy||frame?.mode!=='human'}>{t('打开')}</button></form>
      <div className="collaboration-browser-controls"><span>{frame?.mode==='agent'?t('AI 可查看 · 操作需确认'):t('由你操作')}</span><button type="button" disabled={busy} onClick={()=>void act(frame?.mode==='agent'?'takeover':'handoff')}>{frame?.mode==='agent'?<Hand size={15}/>:<Play size={15}/>} {frame?.mode==='agent'?t('我来操作'):t('交给 AI')}</button><button type="button" disabled={busy} aria-label={t('刷新网页预览')} onClick={()=>void refresh().catch(e=>setError(e.message))}><RefreshCw size={15}/></button><button type="button" disabled={busy} onClick={()=>void act('close')}>{t('关闭浏览器')}</button></div>
      {frame?.pending&&<div className="collaboration-approval" role="status"><strong>{t('AI 想执行这一步，请你确认')}</strong><p>{({navigate:t('打开网页'),click:t('点击页面'),fill:t('填写内容'),key:t('按键操作'),scroll:t('滚动页面')} as Record<string,string>)[frame.pending.action.action]}</p><code>{displayName(frame.pending.action.url??frame.pending.action.selector??(frame.pending.action.x!==undefined?`(${frame.pending.action.x}, ${frame.pending.action.y})`:''))}</code>{frame.pending.action.text&&<pre>{frame.pending.action.text}</pre>}<div><button type="button" disabled={busy} onClick={()=>void act('approve',{pendingId:frame.pending!.id})}>{t('允许这一步')}</button><button type="button" disabled={busy} onClick={()=>void act('deny',{pendingId:frame.pending!.id})}>{t('拒绝')}</button></div></div>}
      {frame&&<><p className="collaboration-page-title" title={frame.url}>{frame.title||frame.url}</p><button type="button" className="collaboration-preview" aria-label={t('网页预览，点击页面位置操作')} disabled={busy||frame.mode!=='human'} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();void act('click',{x:Math.round((e.clientX-r.left)/r.width*frame.width),y:Math.round((e.clientY-r.top)/r.height*frame.height)});}}><img src={frame.image} alt={t('所选主机上的实时网页预览')} draggable={false}/></button></>}
      <form className="collaboration-address" onSubmit={e=>{e.preventDefault();void act('fill',{text:input}).then(ok=>{if(ok)setInput('');});}}><input type="password" autoComplete="off" aria-label={t('输入到网页当前选中位置')} placeholder={t('先点击网页输入框，再在这里输入')} value={input} onChange={e=>setInput(e.target.value)} disabled={busy||frame?.mode!=='human'}/><button disabled={busy||frame?.mode!=='human'||!input} type="submit">{t('输入')}</button></form>
      <div className="collaboration-browser-controls">{['Tab','Enter','Backspace'].map(key=><button type="button" key={key} disabled={busy||frame?.mode!=='human'} onClick={()=>void act('key',{text:key})}>{key}</button>)}<button type="button" disabled={busy||frame?.mode!=='human'} onClick={()=>void act('scroll',{delta:-600})}>{t('向上')}</button><button type="button" disabled={busy||frame?.mode!=='human'} onClick={()=>void act('scroll',{delta:600})}>{t('向下')}</button></div>
      <small>{t('页面预览约每两秒更新。面板超过三十秒未连接时暂停 AI 网页操作；浏览器闲置十分钟关闭。')}</small>
    </>}
    {error&&<p role="alert" className="collaboration-error">{error}</p>}
  </div>;
}

export function TaskBoard({session}:{session:FleetSession}) {
  const [plans,setPlans]=useState<CollaborationPlan[]>([]),[sessions,setSessions]=useState<FleetSession[]>([]),[title,setTitle]=useState(''),[tasks,setTasks]=useState<TaskDraft[]>([{title:'',prompt:'',sessionId:'',dependsOn:[]}]),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[cursor,setCursor]=useState<string|null>(null);
  const prepareKey=useRef<string|null>(null);
  const mutation=useRef<string|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const data=await collaborationApi.plans(session.id,controller.signal);if(!controller.signal.aborted)setPlans(data.plans);}catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{if(!controller.signal.aborted)timer=setTimeout(poll,3000);}};void poll();return()=>{alive.current=false;controller.abort();clearTimeout(timer);};
  },[session.id]);
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{void api.sessions({managed:true,q:query,limit:50},controller.signal).then(page=>{if(!controller.signal.aborted){setSessions(previous=>[...previous.filter(s=>tasks.some(task=>task.sessionId===s.id)&&!page.items.some(item=>item.id===s.id)),...page.items]);setCursor(page.nextCursor);}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},200);return()=>{controller.abort();clearTimeout(timer);};},[query]);
  function edit(index:number,update:Partial<TaskDraft>){mutation.current=null;setTasks(list=>list.map((task,i)=>i===index?{...task,...update}:task));}
  async function run(fn:()=>Promise<CollaborationPlan>){if(busy)return;setBusy(true);setError('');try{const plan=await fn();if(alive.current)setPlans(list=>[plan,...list.filter(p=>p.id!==plan.id)]);return plan;}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
  return <div className="collaboration-taskboard">
    <div className="collaboration-board-intro"><h3>{t('一件事情，分工完成')}</h3><p>{t('选择已接管的助手会话，安排任务和先后关系。最后把结果汇总回当前会话。')}</p><button type="button" className="button button--primary" disabled={creating} onClick={()=>setCreating(true)}><Plus size={16}/>{t('安排分工')}</button></div>
    {creating&&<form className="collaboration-plan-form" onSubmit={e=>{e.preventDefault();mutation.current??=crypto.randomUUID();void run(()=>collaborationApi.create({sessionId:session.id,title,tasks,clientMutationId:mutation.current!,confirmed:true})).then(plan=>{if(plan&&alive.current){setCreating(false);setTitle('');setTasks([{title:'',prompt:'',sessionId:'',dependsOn:[]}]);mutation.current=null;}});}}>
      <label>{t('这次要完成什么')}<input required maxLength={160} value={title} onChange={e=>{mutation.current=null;prepareKey.current=null;setTitle(e.target.value);}} placeholder={t('例如：准备新品活动资料')}/></label>
      <button type="button" disabled={busy||!title.trim()||!sessions.length} onClick={()=>{prepareKey.current??=crypto.randomUUID();void run(()=>collaborationApi.prepare({sessionId:session.id,title,candidates:sessions.slice(0,30).map(s=>s.id),clientMutationId:prepareKey.current!,confirmed:true}));}}>{t('让当前助手拟定分工')}</button><small>{t('先用计划模式拟定草稿，消耗当前助手额度。你审阅并确认后，其他助手才开始执行。')}</small>
      <label>{t('查找助手会话')}<input value={query} onChange={e=>{prepareKey.current=null;setQuery(e.target.value);}} placeholder={t('搜索主机、项目或会话')}/></label>
      {cursor&&<button type="button" onClick={()=>void api.sessions({managed:true,q:query,limit:50,cursor}).then(page=>{setSessions(list=>[...list,...page.items.filter(item=>!list.some(s=>s.id===item.id))]);setCursor(page.nextCursor);}).catch(e=>setError(e.message))}>{t('加载更多会话')}</button>}
      {tasks.map((task,index)=><fieldset key={index}><legend>{t('任务')} {index+1}</legend><label>{t('名称')}<input required maxLength={100} value={task.title} onChange={e=>edit(index,{title:e.target.value})} placeholder={t('例如：竞品资料')}/></label><label>{t('交给谁')}<select required value={task.sessionId} onChange={e=>edit(index,{sessionId:e.target.value})}><option value="">{t('选择已接管会话')}</option>{sessions.map(s=><option key={s.id} value={s.id}>{displayName(`${s.machineName} · ${s.provider==='claude'?'Claude Code':'Codex'} · ${s.title}`)}</option>)}</select></label><label>{t('任务要求')}<textarea required maxLength={12000} rows={3} value={task.prompt} onChange={e=>edit(index,{prompt:e.target.value})}/></label>{index>0&&<label>{t('什么时候开始')}<select value={task.dependsOn[0]??''} onChange={e=>edit(index,{dependsOn:e.target.value===''?[]:[Number(e.target.value)]})}><option value="">{t('可以立即开始')}</option>{tasks.slice(0,index).map((previous,n)=><option key={n} value={n}>{t('等待完成')}：{previous.title||`${t('任务')} ${n+1}`}</option>)}</select></label>}</fieldset>)}
      <div className="collaboration-browser-controls"><button type="button" disabled={tasks.length>=6} onClick={()=>{mutation.current=null;setTasks(list=>[...list,{title:'',prompt:'',sessionId:'',dependsOn:[]}]);}}>{t('增加任务')}</button>{tasks.length>1&&<button type="button" onClick={()=>{mutation.current=null;setTasks(list=>list.slice(0,-1));}}>{t('移除最后一项')}</button>}</div>
      <p>{t('确认后会开始执行并消耗各助手额度。同项目的任务会依次运行，沿用原会话权限；前置结果会提供给依赖它的助手。')}</p><div className="collaboration-browser-controls"><button className="button button--primary" disabled={busy} type="submit">{busy?t('正在提交…'):t('确认分工并开始')}</button><button type="button" disabled={busy} onClick={()=>setCreating(false)}>{t('取消')}</button></div>
    </form>}
    {error&&<p role="alert" className="collaboration-error">{error}</p>}
    {!plans.length&&!creating&&<p className="collaboration-empty">{t('还没有分工任务。先从两件可以独立完成的事开始。')}</p>}
    {plans.map(plan=><article className="collaboration-plan" key={plan.id}><header><strong>{displayName(plan.title)}</strong><span>{t(taskState(plan.state))}</span></header><div className="collaboration-browser-controls">{plan.state==='running'&&<button type="button" disabled={busy} onClick={()=>void run(()=>collaborationApi.action(plan.id,'pause'))}>{t('暂停后续派发')}</button>}{plan.state==='paused'&&<button type="button" disabled={busy} onClick={()=>void run(()=>collaborationApi.action(plan.id,'resume'))}>{t('继续后续任务')}</button>}{['running','paused'].includes(plan.state)&&<button type="button" disabled={busy} onClick={()=>void run(()=>collaborationApi.action(plan.id,'cancel'))}>{t('取消未开始任务')}</button>}{plan.tasks.every(task=>task.state==='completed')&&!plan.tasks.some(task=>task.summary||task.planning)&&<button type="button" disabled={busy} onClick={()=>void run(()=>collaborationApi.action(plan.id,'summarize'))}>{t('让当前助手汇总结果')}</button>}</div>
      {plan.tasks.map((task,index)=><section className="collaboration-task" key={index}><div className="collaboration-task-heading"><strong>{displayName(task.title)}</strong><span data-state={task.state}>{t(taskState(task.state))}</span></div><small>{displayName(task.host??'')} · {task.provider==='claude'?'Claude Code':'Codex'} · {displayName(task.sessionTitle??'')}</small>{task.detail&&<p>{task.detail}</p>}{task.dependsOn.length>0&&<small>{t('依赖')}：{task.dependsOn.map(n=>displayName(plan.tasks[n]?.title??'')).join('、')}</small>}<div className="collaboration-browser-controls"><a href={sessionPath(task.sessionId)} target="_blank" rel="noreferrer">{t('查看会话')} <ArrowUpRight size={13}/></a>{task.turnId&&!['completed','failed','interrupted'].includes(task.state)&&<button type="button" disabled={busy} onClick={()=>void run(()=>collaborationApi.action(plan.id,'stop',index))}>{t('停止此任务')}</button>}</div>{task.planning&&task.state==='completed'&&task.result&&<button type="button" onClick={()=>{try{setTasks(readPlanDraft(task.result));setTitle(plan.title);setCreating(true);mutation.current=null;}catch(e){setError((e as Error).message);}}}>{t('审阅这份分工草稿')}</button>}{task.result&&<details><summary>{t('查看结果')}</summary><pre>{task.result}</pre></details>}{task.state==='completed'&&!task.result&&<small>{t('任务已完成，结果正文暂不可读取，请打开原会话查看。')}</small>}</section>)}
    </article>)}
  </div>;
}
