import {randomUUID} from 'node:crypto';
import {AppError,invariant} from './errors.js';
import type {HistoryBinding} from './session-history.js';
export interface BrowserEndpoint {key:object;generation:number;producerEpoch:string;appServerEpoch:string;supported:boolean;statusSupported?:boolean;send:(value:Record<string,unknown>)=>boolean;}
/** Ephemeral browser RPCs, bound to an authenticated host generation. Actions are never replayed. */
export class BrowserBroker {
 private pending=new Map<string,{machineId:string;endpoint:BrowserEndpoint;finish:(error:AppError|null,result?:Record<string,unknown>)=>void}>();
 constructor(private endpoint:(machineId:string)=>BrowserEndpoint|undefined,private timeoutMs=25000){}
 control(binding:HistoryBinding,input:Record<string,unknown>):Promise<Record<string,unknown>> {
  const endpoint=this.endpoint(binding.machineId);
  invariant(endpoint,409,'BROWSER_HOST_OFFLINE','主机连接尚未就绪，暂不能读取原生浏览器');
  invariant(endpoint.supported,409,'BROWSER_UNSUPPORTED','此主机连接服务尚不支持浏览器，请更新后重试');
  if(input.action==='status')invariant(endpoint.statusSupported,409,'BROWSER_UPDATE_REQUIRED','请检查并更新连接服务，以恢复共享浏览器状态');
  invariant([...this.pending.values()].filter(p=>p.machineId===binding.machineId).length<2,429,'BROWSER_BUSY','浏览器读取繁忙，请稍后再试');
  return new Promise((resolve,reject)=>{
   const requestId=randomUUID();
   const timer=setTimeout(()=>finish(new AppError(504,'BROWSER_TIMEOUT','网页操作回执超时，请核实页面；不会自动重试')),this.timeoutMs);
   const finish=(error:AppError|null,result?:Record<string,unknown>)=>{clearTimeout(timer);this.pending.delete(requestId);if(error)reject(error);else resolve(result!);};
   this.pending.set(requestId,{machineId:binding.machineId,endpoint,finish});
   try {if(!endpoint.send({type:'browser.control',requestId,logicalSessionId:binding.sessionId,projectExternalId:binding.projectExternalId,nativeThreadId:binding.nativeThreadId,executionSegmentId:binding.executionSegmentId,contentEpoch:binding.contentEpoch,transportGeneration:endpoint.generation,producerEpoch:endpoint.producerEpoch,appServerEpoch:endpoint.appServerEpoch,input}))finish(new AppError(409,'BROWSER_HOST_OFFLINE','主机连接已断开'));}
   catch {finish(new AppError(409,'BROWSER_HOST_OFFLINE','主机连接已断开'));}
  });
 }
 receive(machineId:string,key:object,message:{requestId:string;result?:unknown;error?:{code?:string;message?:string}}) {
  const pending=this.pending.get(message.requestId);if(!pending||pending.machineId!==machineId||pending.endpoint.key!==key)return;
  const current=this.endpoint(machineId);
  if(!current||current.key!==key||current.generation!==pending.endpoint.generation||current.producerEpoch!==pending.endpoint.producerEpoch||current.appServerEpoch!==pending.endpoint.appServerEpoch){pending.finish(new AppError(409,'BROWSER_TARGET_CHANGED','主机连接已变化，请重新读取'));return;}
  if(message.error){const code=typeof message.error.code==='string'&&/^BROWSER_[A-Z_]+$/.test(message.error.code)?message.error.code:'BROWSER_READ_FAILED';pending.finish(new AppError(409,code,typeof message.error.message==='string'?message.error.message.slice(0,500):'浏览器操作未确认成功，请查看页面，不要重复执行'));return;}
  if(!message.result||typeof message.result!=='object'||Array.isArray(message.result)){pending.finish(new AppError(502,'BROWSER_INVALID','浏览器响应无效'));return;}
  pending.finish(null,message.result as Record<string,unknown>);
 }
 disconnect(machineId:string,key:object){for(const pending of this.pending.values())if(pending.machineId===machineId&&pending.endpoint.key===key)pending.finish(new AppError(409,'BROWSER_HOST_OFFLINE','主机读取期间断开连接'));}
 close(){for(const pending of this.pending.values())pending.finish(new AppError(503,'BROWSER_UNAVAILABLE','服务正在关闭，请稍后重试'));}
}
