import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import type {FleetSession,CommandReceipt} from '../lib/types';
import {grokOperations,type GrokOperation} from '../lib/grok-operations';
import {t} from '../i18n';

const labels:Record<GrokOperation,string>={
 'git.commit':'提交已暂存的改动','worktrees.diff':'查看工作树差异','worktrees.apply':'合并工作树改动','subagent.get':'查看子智能体结果',
 'git.status':'Git 状态','git.diff':'查看 Git 差异','search.content':'搜索项目内容','mcp.authStatus':'MCP 授权状态',
 'marketplace.list':'读取插件市场','plugins.install':'安装插件','plugins.update':'更新插件','plugins.uninstall':'卸载插件',
 'worktrees.create':'新建 Git 工作树','scheduler.delete':'删除原生定时任务',
 'memory.preview':'预览记忆','session.fork':'分叉会话','session.compact':'压缩上下文','memory.enable':'开启原生记忆','memory.disable':'关闭原生记忆','plugins.enable':'启用插件','plugins.disable':'停用插件','plugins.reload':'重新读取插件','hooks.enable':'启用钩子','hooks.disable':'停用钩子','hooks.reload':'重新读取钩子',
 'tasks.list':'后台任务','subagents.list':'子智能体','commands.list':'原生命令','history.list':'输入历史','rewind.list':'回退检查点',
 'memory.list':'查看记忆','hooks.list':'查看钩子','plugins.list':'查看插件','skills.list':'查看技能','mcp.list':'查看 MCP 连接',
 'worktrees.list':'查看工作树','task.stop':'停止后台任务','subagent.stop':'停止子智能体','memory.flush':'保存原生记忆',
 'memory.dream':'整理原生记忆','memory.forget':'删除原生记忆','session.rename':'重命名会话','rewind.execute':'回退会话','btw.ask':'随口问',
};
const fields:Record<string,string>={message:'提交说明',worktreePath:'工作树路径',pattern:'搜索文字',source:'插件 HTTPS 仓库',pluginId:'插件 ID',hookName:'钩子名称',mode:'回退范围',taskId:'任务 ID',subagentId:'子智能体 ID',path:'记忆文件路径',expectedContentHash:'预览内容校验值',title:'会话名称',targetPromptIndex:'检查点序号',question:'问题'};
const taskDrafts=[
 ['生成图片','请生成图片。主题、风格与尺寸：'],
 ['生成视频','请生成视频。内容、时长、画幅与参考素材：'],
 ['创建子智能体','请使用原生子智能体完成以下任务，并汇总结果。任务与分工：'],
 ['设置循环任务','请设置原生循环任务。执行内容、间隔与停止条件：'],
 ['审查代码','请审查以下改动，报告有证据的问题与影响。审查范围：'],
] as const;
export function GrokNativePanel({session,commands,supported,onChanged,onCompose}:{session:FleetSession;commands:CommandReceipt[];supported:boolean;onChanged:()=>void;onCompose?:(draft:string)=>void}){
 const [operation,setOperation]=useState<GrokOperation>('tasks.list'),[args,setArgs]=useState<Record<string,string>>({}),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[submitted,setSubmitted]=useState<string>();
 const receipt=submitted?commands.find(c=>c.id===submitted):commands.find(c=>c.type==='grok.manage'&&c.grokResult?.operation===operation),result=receipt?.grokResult;
 const pending=commands.some(c=>c.type==='grok.manage'&&['accepted','dispatching','unknown'].includes(c.state));
 const spec=grokOperations[operation],hasNative=Boolean(session.nativeThreadId);
 useEffect(()=>{if(!submitted||!pending)return;const timer=window.setInterval(onChanged,3000);return()=>window.clearInterval(timer);},[submitted,pending,onChanged]);
 async function run(){
  if(busy||pending||!supported||!hasNative||spec.write&&!confirmed)return;
  setBusy(true);setNotice('');
  const values=Object.fromEntries(spec.fields.map(k=>[k,k==='targetPromptIndex'?Number(args[k]):k==='mode'?(args[k]??'conversation_only'):args[k]]));
  try{
   const response=await api.command(session.id,{type:'grok.manage',clientMutationId:crypto.randomUUID(),payload:{operation,arguments:values,...(spec.write?{confirmed:true}:{})},precondition:{nativeThreadId:session.nativeThreadId,executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:session.activeTurnId??null,projectLeaseVersion:session.projectLeaseVersion}});
   setSubmitted(response.command.id);setNotice(t('请求已提交，正在等待宿主机回执。'));setConfirmed(false);onChanged();
  }catch(e){setNotice(e instanceof Error?e.message:t('操作失败'));}finally{setBusy(false);}
 }
 return <details className="codex-settings-panel config-disclosure"><summary>{t('Grok 原生工具')}</summary><div className="config-disclosure__body">
  <p>{t('按需读取当前会话的原生状态。不会自动执行历史指令；原生后台任务与面板定时任务分别管理。')}</p>
  <p className="subtle">{t('结果最多显示 100 条、共 24000 字符；超过范围请使用原生客户端。未提供的接口会明确报错。')}</p>
  {onCompose&&<details><summary>{t('原生任务入口')}</summary><p className="subtle">{t('仅填入草稿，补充要求后发送。是否可执行取决于原生工具、账号与权限；不会自动启动任务。')}</p><div className="grok-task-entries">{taskDrafts.map(([label,draft])=><button type="button" className="button button--secondary" key={label} onClick={()=>onCompose(t(draft))}>{t(label)}</button>)}</div></details>}
  {!supported&&<p role="status">{t('请先更新主机连接服务并重新读取原生能力。')}</p>}
  {supported&&!hasNative&&<p role="status">{t('先发送一条消息或接管原生会话，再使用原生工具。')}</p>}
  <form className="stack-form" onSubmit={e=>{e.preventDefault();void run();}}>
   <label>{t('操作')}<select value={operation} disabled={busy||pending} onChange={e=>{setOperation(e.target.value as GrokOperation);setArgs({});setConfirmed(false);setSubmitted(undefined);setNotice('');}}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{t(label)}</option>)}</select></label>
   {spec.fields.map(key=>key==='mode'?<label key={key}>{t('回退范围')}<select required value={args.mode??'conversation_only'} onChange={e=>{setArgs({...args,mode:e.target.value});setConfirmed(false);}}><option value="conversation_only">{t('仅会话上下文')}</option><option value="files_only">{t('仅文件')}</option><option value="all">{t('会话上下文和文件')}</option></select></label>:<label key={key}>{t(fields[key])}<input required type={key==='targetPromptIndex'?'number':'text'} min={key==='targetPromptIndex'?0:undefined} value={args[key]??''} maxLength={key==='question'||key==='message'?4000:key==='path'||key==='worktreePath'?4096:256} onChange={e=>{setArgs({...args,[key]:e.target.value});setConfirmed(false);}}/></label>)}
   {spec.write&&<label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{t(operation==='git.commit'?'确认提交当前仓库已暂存的改动，不自动暂存、推送或改写提交。':operation==='worktrees.apply'?'确认合并此会话工作树到当前项目。原生接口可能应用部分文件后报告冲突，不会强制覆盖冲突。':operation==='rewind.execute'?'确认按所选范围回退。面板保留原有审计记录；不会强制中断任务。':operation==='memory.forget'?'确认永久删除已预览且校验值一致的原生记忆。':'确认对当前原生目标执行此操作。记忆操作可能影响此主机的其他会话；原生处理可能消耗额度。')}</label>}
   <button type="submit" className="button button--secondary" disabled={!supported||!hasNative||busy||pending||spec.write&&!confirmed}>{t(busy||pending?'正在处理…':spec.write?'执行':'读取')}</button>
  </form>
  {notice&&<p role="status">{notice}</p>}
  {receipt?.message&&<p role="status">{receipt.message}</p>}
  {result&&<section aria-label={t('原生操作结果')}><p>{t('原生返回状态')}：{result.status}{receipt?.createdAt&&<> · <time dateTime={receipt.createdAt}>{new Date(receipt.createdAt).toLocaleString()}</time></>}</p>{!result.rows.length&&<p>{t('原生未返回可展示的条目。')}</p>}{result.rows.map((row,index)=><details key={index}><summary>{row.name}{row.status?' · '+row.status:''}</summary><pre className="grok-native-result">{row.detail}</pre></details>)}</section>}
 </div></details>;
}
