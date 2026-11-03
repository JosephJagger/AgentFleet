import {verifyProjectIdentity} from './projects.js';
import type { AppServerClient } from './app-server.js';
import type { StateStore } from './store.js';
import type { AgentState } from './types.js';
import { AgentError } from './errors.js';
import { canonicalJson, nowIso } from './util.js';
import { isAcpProvider } from './provider-catalog.js';

export function recoveredTurnKey(nativeThreadId:string,epoch:string,turnId:string) { return JSON.stringify([nativeThreadId,epoch,turnId]); }

/** User-directed disposal of pending bookkeeping, never native task execution. */
export async function retrySessionRecovery(store:StateStore,server:AppServerClient,target:Record<string,unknown>,stillCurrent:()=>boolean):Promise<Record<string,unknown>> {
 const {logicalSessionId,executionSegmentId,contentEpoch,projectExternalId,recoveryToken}=target;
 if(typeof logicalSessionId!=='string'||typeof executionSegmentId!=='string'||(target.nativeThreadId!==null&&typeof target.nativeThreadId!=='string')||typeof projectExternalId!=='string'||typeof contentEpoch!=='number'||typeof recoveryToken!=='string'||!/^(sha256:)?[a-f0-9]{64}$/.test(recoveryToken))throw new AgentError('RECOVERY_TARGET_INVALID','会话恢复目标无效，请刷新后重试');
 if(target.appServerEpoch!==server.appServerEpoch)throw new AgentError('RECOVERY_RUNTIME_CHANGED','主机刚刚重连，请重新点击重试恢复');
 const before=store.snapshot();const existing=before.sessionRecoveryReceipts?.[recoveryToken];if(existing)return existing;
 const project=before.projects.find(p=>p.id===projectExternalId);if(!project)throw new AgentError('PROJECT_UNAVAILABLE','会话项目已不存在，请先修正项目目录');
 await verifyProjectIdentity(project);
 const candidates=[...new Set([...Object.values(before.managedThreads),...Object.values(before.nativeThreadBindings)].filter(t=>t.logicalSessionId===logicalSessionId&&t.executionSegmentId===executionSegmentId&&t.contentEpoch===contentEpoch&&t.projectId===project.id).map(t=>t.nativeThreadId))];
 if(target.nativeThreadId===null&&candidates.length>1)throw new AgentError('RECOVERY_TARGET_CHANGED','主机存在多个原会话绑定，请重新扫描主机会话后重试');
 const nativeThreadId=typeof target.nativeThreadId==='string'?target.nativeThreadId:candidates[0]??null;
 const thread=nativeThreadId?before.managedThreads[nativeThreadId]:undefined,binding=nativeThreadId?before.nativeThreadBindings[nativeThreadId]:undefined;
 for(const value of [thread,binding])if(value&&(value.logicalSessionId!==logicalSessionId||value.executionSegmentId!==executionSegmentId||value.contentEpoch!==contentEpoch||value.projectId!==project.id))throw new AgentError('RECOVERY_TARGET_CHANGED','会话状态已变化，请重新点击重试恢复');
 if(nativeThreadId&&!thread&&!binding&&before.discoveredThreads[nativeThreadId]?.projectId!==project.id)throw new AgentError('RECOVERY_NATIVE_MISSING','未找到原生会话，请先重新扫描主机会话；原会话文件缺失时需要新建会话');
 if(thread?.realtimeSessionId||before.panelVoiceRuntime)throw new AgentError('RECOVERY_VOICE_ACTIVE','请先结束语音通话');
 const commands=Array.isArray(target.commands)?target.commands:[];
 if(commands.length>1000||commands.some(c=>!c||typeof c!=='object'||typeof c.command_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(c.command_id)))throw new AgentError('RECOVERY_TARGET_INVALID','会话待处理操作列表无效');
 const ids=new Set<string>(commands.map(c=>c.command_id));
 // Without a native identity, only a durable pre-invocation journal proves that no task ran.
 if(!nativeThreadId&&(!ids.size||[...ids].some(id=>{const j=before.commandJournal[id];return !j||j.invokingAt||j.response||!['claimed','unknown','rejected'].includes(j.state);})))throw new AgentError('RECOVERY_NATIVE_MISSING','尚未找到原生会话，请在主机设置中重新扫描会话后重试恢复');
 const reservation=before.projectReservations[project.id];
 if(reservation&&!ids.has(reservation.commandId))throw new AgentError('RECOVERY_TARGET_CHANGED','会话状态已变化，请重新点击重试恢复');
 if(thread?.activeTurnId&&typeof target.nativeTurnId==='string'&&thread.activeTurnId!==target.nativeTurnId)throw new AgentError('RECOVERY_TARGET_CHANGED','会话状态已变化，请重新点击重试恢复');
 const fingerprint=(s:AgentState)=>canonicalJson({
  threads:Object.values(s.managedThreads).filter(t=>t.projectId===project.id).map(t=>({nativeThreadId:t.nativeThreadId,logicalSessionId:t.logicalSessionId,executionSegmentId:t.executionSegmentId,contentEpoch:t.contentEpoch,appServerEpoch:t.appServerEpoch,activeTurnId:t.activeTurnId??null,realtimeSessionId:t.realtimeSessionId??null,sessionCwd:t.sessionCwd??null})),
  bindings:Object.values(s.nativeThreadBindings).filter(b=>b.logicalSessionId===logicalSessionId),
  binding:nativeThreadId?s.nativeThreadBindings[nativeThreadId]??null:null,reservation:s.projectReservations[project.id]??null,voice:s.panelVoiceRuntime??null,
  journals:[...ids].map(id=>s.commandJournal[id]??null),approvals:Object.values(s.approvals).filter(a=>a.nativeThreadId===nativeThreadId)
 });
 const expected=fingerprint(before);
 if(nativeThreadId){
 const snapshot=await server.readThread(nativeThreadId,!isAcpProvider(project.provider));
 if(snapshot.nativeThreadId!==nativeThreadId||snapshot.cwd!==(thread?.sessionCwd??binding?.sessionCwd??project.root))throw new AgentError('RECOVERY_TARGET_CHANGED','原生会话目录或身份已变化，请先修正项目目录');
 if(!['idle','completed','failed','interrupted'].includes(snapshot.executionState))return {recovered:false,reason:'主机仍报告任务在运行，请先停止任务后再重试恢复'};
 if(thread||isAcpProvider(project.provider))await server.unsubscribeThread(nativeThreadId);
 }
 if(!stillCurrent())throw new AgentError('RECOVERY_RUNTIME_CHANGED','主机刚刚重连，请重新点击重试恢复');
 const oldTurn=thread?.activeTurnId??(typeof target.nativeTurnId==='string'?target.nativeTurnId:undefined);
 const receipt={recovered:true,recoveryToken,nativeThreadId,nativeTurnId:oldTurn??null,status:oldTurn?'interrupted':'idle',resultKnown:false,reason:'已解除挂起，可以继续原会话。上一轮结果仍未确认，原任务没有重发。'};
 return store.update(s=>{
  if(fingerprint(s)!==expected)throw new AgentError('RECOVERY_TARGET_CHANGED','会话状态已变化，请重新点击重试恢复');
  const at=nowIso();
  s.recoveryDisposals??={};for(const id of ids)s.recoveryDisposals[id]={logicalSessionId,executionSegmentId,contentEpoch,recoveredAt:at};
  if(s.projectReservations[project.id])delete s.projectReservations[project.id];
  const current=nativeThreadId?s.managedThreads[nativeThreadId]:undefined;
  if(current&&nativeThreadId){
   if(oldTurn){s.recoveredTurns??={};s.recoveredTurns[recoveredTurnKey(nativeThreadId,current.appServerEpoch,oldTurn)]=at;s.recoveredTurns[recoveredTurnKey(nativeThreadId,server.appServerEpoch,oldTurn)]=at;}
   delete current.activeTurnId;delete current.activeTurnSettings;current.appServerEpoch=server.appServerEpoch;current.policyVerified=false;current.subscribed=false;
   if(oldTurn&&(!current.lastTurnId||current.lastTurnId===oldTurn)){current.lastTurnId=oldTurn;current.lastTurnStatus='interrupted';}
  }
  for(const a of Object.values(s.approvals))if(a.nativeThreadId===nativeThreadId&&['pending','delivery_unknown'].includes(a.state))a.state='invalidated';
  const discovered=nativeThreadId?s.discoveredThreads[nativeThreadId]:undefined;if(discovered){discovered.executionState="idle";discovered.availability="available";discovered.lastReconciledAt=at;}
  s.sessionRecoveryReceipts??={};s.sessionRecoveryReceipts[recoveryToken]=receipt;
  return receipt;
 });
}
