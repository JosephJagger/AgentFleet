import {randomUUID} from 'node:crypto';
import {AppError,invariant} from './errors.js';
import type {HistoryBinding} from './session-history.js';
export interface HistoryEndpoint {key:object;generation:number;producerEpoch:string;appServerEpoch:string;supported:boolean;send:(value:Record<string,unknown>)=>boolean;}
/** Ephemeral read RPCs: no command, lease, task or writer is created. */
export class SessionHistoryBroker {
 private pending=new Map<string,{machineId:string;endpoint:HistoryEndpoint;finish:(error:AppError|null,result?:Record<string,unknown>)=>void}>();
 constructor(private endpoint:(machineId:string)=>HistoryEndpoint|undefined,private timeoutMs=20000){}
 read(binding:HistoryBinding,cursor:string|null):Promise<Record<string,unknown>> {
  const endpoint=this.endpoint(binding.machineId);
  invariant(endpoint,409,'HISTORY_HOST_OFFLINE','主机连接尚未就绪，暂不能读取原生历史');
  invariant(endpoint.supported,409,'HISTORY_UNSUPPORTED','此主机连接服务尚不支持只读历史，请更新后重试');
  invariant([...this.pending.values()].filter(p=>p.machineId===binding.machineId).length<2,429,'HISTORY_BUSY','主机历史读取繁忙，请稍后再试');
  return new Promise((resolve,reject)=>{
   const requestId=randomUUID();
   const timer=setTimeout(()=>finish(new AppError(504,'HISTORY_TIMEOUT','主机历史读取超时；未启动任务')),this.timeoutMs);
   const finish=(error:AppError|null,result?:Record<string,unknown>)=>{clearTimeout(timer);this.pending.delete(requestId);if(error)reject(error);else resolve(result!);};
   this.pending.set(requestId,{machineId:binding.machineId,endpoint,finish});
   try {if(!endpoint.send({type:'session.history.read',requestId,logicalSessionId:binding.sessionId,projectExternalId:binding.projectExternalId,nativeThreadId:binding.nativeThreadId,executionSegmentId:binding.executionSegmentId,contentEpoch:binding.contentEpoch,transportGeneration:endpoint.generation,producerEpoch:endpoint.producerEpoch,appServerEpoch:endpoint.appServerEpoch,cursor}))finish(new AppError(409,'HISTORY_HOST_OFFLINE','主机连接已断开'));}
   catch {finish(new AppError(409,'HISTORY_HOST_OFFLINE','主机连接已断开'));}
  });
 }
 receive(machineId:string,key:object,message:{requestId:string;result?:unknown;error?:{code?:string}}) {
  const pending=this.pending.get(message.requestId);if(!pending||pending.machineId!==machineId||pending.endpoint.key!==key)return;
  const current=this.endpoint(machineId);
  if(!current||current.key!==key||current.generation!==pending.endpoint.generation||current.producerEpoch!==pending.endpoint.producerEpoch||current.appServerEpoch!==pending.endpoint.appServerEpoch){pending.finish(new AppError(409,'HISTORY_TARGET_CHANGED','主机连接已变化，请重新读取'));return;}
  if(message.error){const code=typeof message.error.code==='string'&&/^HISTORY_[A-Z_]+$/.test(message.error.code)?message.error.code:'HISTORY_READ_FAILED';pending.finish(new AppError(409,code,'主机未能完成只读历史查询；没有启动或重派任务'));return;}
  if(!message.result||typeof message.result!=='object'||Array.isArray(message.result)){pending.finish(new AppError(502,'HISTORY_INVALID','主机历史响应无效'));return;}
  pending.finish(null,message.result as Record<string,unknown>);
 }
 disconnect(machineId:string,key:object){for(const pending of this.pending.values())if(pending.machineId===machineId&&pending.endpoint.key===key)pending.finish(new AppError(409,'HISTORY_HOST_OFFLINE','主机读取期间断开连接'));}
 close(){for(const pending of this.pending.values())pending.finish(new AppError(503,'HISTORY_UNAVAILABLE','服务正在关闭，请稍后重试'));}
}
