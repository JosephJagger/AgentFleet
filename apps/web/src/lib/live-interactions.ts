/** HomeDouyinCollector's Companion-log WebSocket stream; not an official Douyin API. */
export interface LiveEvent {
  id:string; roomId:string; ownerId:string; ownerName:string; roomTitle:string;
  userId:string; name:string; content:string; type:'chat'|'enter'; receivedAt:number; anonymous?:boolean; isAnchor?:boolean; collector?:'companion-log'; sourceObservedAt?:number;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
const identifier=(v:unknown)=>typeof v==='string'&&/^[\w:-]{1,100}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):'';
// Newtonsoft emits 64-bit numeric IDs. Never round them through JS Number.
function json(raw:string):unknown {
  return JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(token,quoted)=>quoted?token:/^-?\d{16,}$/.test(token)?JSON.stringify(token):token));
}
export type CollectorRejection='binary'|'oversize'|'format'|'source'|'unsupported'|'room'|'message'|'native'|'stale';
export type CollectorPacket={event:LiveEvent;reason?:never}|{event?:never;reason:CollectorRejection};
/** Decode the documented envelope before deciding whether it is suitable for display or voice. */
export function inspectLivePacket(raw:unknown,now=Date.now()):CollectorPacket {
  if(typeof raw!=='string')return {reason:'binary'};
  if(raw.length>65536)return {reason:'oversize'};
  try {
    const pack=object(json(raw));
    if(!('Type' in pack)||!('Data' in pack))return {reason:'format'};
    if(!['直播伴侣','直播伴侣.exe'].includes(String(pack.ProcessName)))return {reason:'source'};
    if(![1,3].includes(pack.Type as number))return {reason:'unsupported'};
    const data=object(typeof pack.Data==='string'?json(pack.Data):pack.Data),user=object(data.User);
    const type=pack.Type===1?'chat':'enter';
    const roomId=identifier(data.RoomId),ownerId=identifier(object(data.Owner).UserId);
    if(!roomId)return {reason:'room'};
    const id=identifier(data.MsgId),userId=identifier(user.Id);
    const collector=data.CollectorSource==='companion-log'?'companion-log':undefined;
    let sourceObservedAt:number|undefined;
    {
      if(!collector||!['chat','enter'].includes(type)||data.NativeMethod!==(type==='enter'?'WebcastMemberMessage':'WebcastChatMessage')||(type==='enter'&&String(data.Action)!=='1'))return {reason:'native'};
      sourceObservedAt=typeof data.ObservedAt==='string'?Date.parse(data.ObservedAt):NaN;
      if(!Number.isFinite(sourceObservedAt)||sourceObservedAt>now+5000||now-sourceObservedAt>20000)return {reason:'stale'};
      if(!userId)return {reason:'message'};
    }
    if((type==='chat'||type==='enter')&&!id)return {reason:'message'};
    if(type==='chat'&&typeof data.Content!=='string')return {reason:'message'};
    return {event:{type,id,roomId,ownerId,ownerName:'',roomTitle:'',userId,name:text(user.Nickname),content:type==='chat'?text(data.Content,2000):'',receivedAt:collector?Math.min(now,sourceObservedAt!):now,...(collector?{collector,sourceObservedAt}:{}),anonymous:data.IsAnonymous===true,isAnchor:user.IsAnchor===true}};
  }catch{return {reason:'format'};}
}
export function parseLiveEvent(raw:string,now=Date.now()):LiveEvent|null {
  return inspectLivePacket(raw,now).event??null;
}
export interface CollectorDiagnostics {
  packets:number;chat:number;enter:number;rejected:number;lastPacketAt:number;
  reasons:Partial<Record<CollectorRejection,number>>;
}
export const emptyCollectorDiagnostics=():CollectorDiagnostics=>({packets:0,chat:0,enter:0,rejected:0,lastPacketAt:0,reasons:{}});
export class LiveCollectorStream {
  diagnostics=emptyCollectorDiagnostics();
  read(raw:unknown,now=Date.now()):CollectorPacket {
    const d=this.diagnostics;d.packets++;d.lastPacketAt=now;
    const result=inspectLivePacket(raw,now);
    if(!result.event){d.rejected++;d.reasons[result.reason]=(d.reasons[result.reason]??0)+1;return result;}
    if(result.event.type==='chat')d.chat++;else d.enter++;
    return result;
  }
}
export function welcomeEligible(event:LiveEvent) {return event.type==='enter'&&Boolean(event.userId&&event.collector==='companion-log')&&event.userId!==event.ownerId&&!event.anonymous&&!event.isAnchor;}
export function localCollectorUrl(port:string) {
  if(!/^\d{1,5}$/.test(port)||Number(port)<1024||Number(port)>65535)throw new Error('Invalid local port');
  return `ws://127.0.0.1:${Number(port)}/`;
}
/** Bounded receive ledger, independent of the visible 100 messages and welcome toggle. */
export class LiveEventLedger {
  private seen=new Map<string,number>();
  private viewers=new Map<string,number>();
  private prune(map:Map<string,number>,now:number){for(const [key,at] of map)if(now-at>=600000)map.delete(key);}
  accept(event:LiveEvent){this.prune(this.seen,event.receivedAt);const key=`${event.roomId}:${event.type}:${event.id}`;if(this.seen.has(key))return false;if(this.seen.size>=5000)this.seen.delete(this.seen.keys().next().value!);this.seen.set(key,event.receivedAt);return true;}
  welcome(event:LiveEvent){if(!welcomeEligible(event))return false;this.prune(this.viewers,event.receivedAt);const key=`${event.roomId}:${event.userId}`;if(this.viewers.has(key)||this.viewers.size>=5000)return false;this.viewers.set(key,event.receivedAt);return true;}
}

export interface WelcomeBridge {
  status:()=> 'unavailable'|'unknown'|'busy'|'ready';
  send:(event:LiveEvent)=>boolean;
  receipt?:{requestId:string;status:string;reason?:string};
}
