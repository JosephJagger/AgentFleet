/** HomeDouyinCollector's explicitly identified local sources; not an official Douyin API. */
export type LiveCollectorSource='companion-log'|'companion-memory-bridge'|'douyin-browser-network';
export interface LiveEvent {
  id:string; roomId:string; ownerId:string; ownerName:string; roomTitle:string;
  userId:string; name:string; content:string; contentTruncated?:boolean; type:'chat'|'enter'|'interaction'; interaction?:'like'|'follow'|'gift'|'fansclub'|'share'; count?:number; giftName?:string; receivedAt:number; anonymous?:boolean; isAnchor?:boolean; collector?:LiveCollectorSource; collectorTransport?:string; sourceObservedAt?:number;
}
export const DEFAULT_LIVE_WELCOME='嗨，你好，欢迎光临';
export const LIVE_WELCOME_STORAGE_KEY='agentfleet.live-interactions.welcome-text';
export function normalizeWelcomeText(value:unknown):string|null {
  if(typeof value!=='string')return null;
  const text=value.trim();
  return text.length>0&&text.length<=200&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)?text:null;
}
export function savedWelcomeText():string {
  try{return normalizeWelcomeText(localStorage.getItem(LIVE_WELCOME_STORAGE_KEY))??DEFAULT_LIVE_WELCOME;}catch{return DEFAULT_LIVE_WELCOME;}
}
export const LIVE_WELCOME_INTERVAL_MS=3000;
export const LIVE_WELCOME_MAX_AGE_MS=120000;
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
    if(!['直播伴侣','直播伴侣.exe','HomeDouyinBrowser'].includes(String(pack.ProcessName)))return {reason:'source'};
    if(![1,2,3,4,5,7,8].includes(pack.Type as number))return {reason:'unsupported'};
    const data=object(typeof pack.Data==='string'?json(pack.Data):pack.Data),user=object(data.User);
    const type=pack.Type===1?'chat':pack.Type===3?'enter':'interaction';
    const interaction=({2:'like',4:'follow',5:'gift',7:'fansclub',8:'share'} as const)[pack.Type as 2|4|5|7|8];
    const method=({1:'WebcastChatMessage',2:'WebcastLikeMessage',3:'WebcastMemberMessage',4:'WebcastSocialMessage',5:'WebcastGiftMessage',7:'WebcastFansclubMessage',8:'WebcastSocialMessage'} as Record<number,string>)[pack.Type as number];
    const roomId=identifier(data.RoomId),ownerId=identifier(object(data.Owner).UserId);
    if(!roomId)return {reason:'room'};
    const id=identifier(data.MsgId),userId=identifier(user.Id);
    const collector:LiveCollectorSource|undefined=['companion-log','companion-memory-bridge','douyin-browser-network'].includes(String(data.CollectorSource))?data.CollectorSource as LiveCollectorSource:undefined;
    if(!collector)return {reason:'native'};
    const browser=collector==='douyin-browser-network';
    if(browser?pack.ProcessName!=='HomeDouyinBrowser':!['直播伴侣','直播伴侣.exe'].includes(String(pack.ProcessName)))return {reason:'source'};
    // Display sources are explicit; neither new source can supply an entry/welcome.
    if(collector==='companion-memory-bridge'&&(type!=='chat'||data.CollectorTransport!=='native-publish-message'))return {reason:'native'};
    if(browser&&(type==='enter'||!['websocket','http-fetch'].includes(String(data.CollectorTransport))))return {reason:'native'};
    const collectorTransport=typeof data.CollectorTransport==='string'?data.CollectorTransport:undefined;
    let sourceObservedAt:number|undefined;
    {
      if(!collector||data.NativeMethod!==method||(type==='enter'&&String(data.Action)!=='1'))return {reason:'native'};
      sourceObservedAt=typeof data.ObservedAt==='string'?Date.parse(data.ObservedAt):NaN;
      if(!Number.isFinite(sourceObservedAt)||sourceObservedAt>now+30000||now-sourceObservedAt>86400000)return {reason:'stale'};
      if(type==='enter'&&!userId)return {reason:'message'};
    }
    if(!id)return {reason:'message'};
    if(type==='chat'&&typeof data.Content!=='string')return {reason:'message'};
    return {event:{type,id,roomId,ownerId,ownerName:'',roomTitle:'',userId,name:text(user.Nickname),content:type==='enter'?'':text(data.Content,2000),contentTruncated:typeof data.Content==='string'&&data.Content.length>2000,...(interaction?{interaction,count:Math.min(1000000,Math.max(1,Number(data.Count??data.GiftCount??data.RepeatCount)||1)),giftName:text(data.GiftName,100)}:{}),receivedAt:collector?Math.min(now,sourceObservedAt!):now,...(collector?{collector,sourceObservedAt,collectorTransport}:{}),anonymous:data.IsAnonymous===true,isAnchor:user.IsAnchor===true}};
  }catch{return {reason:'format'};}
}
export function parseLiveEvent(raw:string,now=Date.now()):LiveEvent|null {
  return inspectLivePacket(raw,now).event??null;
}
export interface CollectorDiagnostics {
  packets:number;chat:number;enter:number;interaction:number;rejected:number;lastPacketAt:number;
  reasons:Partial<Record<CollectorRejection,number>>;
}
export const emptyCollectorDiagnostics=():CollectorDiagnostics=>({packets:0,chat:0,enter:0,interaction:0,rejected:0,lastPacketAt:0,reasons:{}});
export class LiveCollectorStream {
  diagnostics=emptyCollectorDiagnostics();
  read(raw:unknown,now=Date.now()):CollectorPacket {
    const d=this.diagnostics;d.packets++;d.lastPacketAt=now;
    const result=inspectLivePacket(raw,now);
    if(!result.event){d.rejected++;d.reasons[result.reason]=(d.reasons[result.reason]??0)+1;return result;}
    if(result.event.type==='chat')d.chat++;else if(result.event.type==='enter')d.enter++;else d.interaction++;
    return result;
  }
}
export function welcomeEligible(event:LiveEvent,now=Date.now()) {return now-event.receivedAt<=LIVE_WELCOME_MAX_AGE_MS&&event.receivedAt<=now+30000&& event.type==='enter'&&Boolean(event.userId&&event.collector==='companion-log')&&event.userId!==event.ownerId&&!event.anonymous&&!event.isAnchor;}
export function localCollectorUrl(port:string) {
  if(!/^\d{1,5}$/.test(port)||Number(port)<1024||Number(port)>65535)throw new Error('Invalid local port');
  return `ws://127.0.0.1:${Number(port)}/`;
}
/** Bounded receive ledger, independent of the visible 100 messages and welcome toggle. */
export class LiveEventLedger {
  private seen=new Map<string,number>();
  private prune(map:Map<string,number>,now:number){for(const [key,at] of map)if(now-at>=600000)map.delete(key);}
  accept(event:LiveEvent){this.prune(this.seen,event.receivedAt);const key=`${event.roomId}:${event.type}:${event.id}`;if(this.seen.has(key))return false;if(this.seen.size>=5000)this.seen.delete(this.seen.keys().next().value!);this.seen.set(key,event.receivedAt);return true;}
  welcome(event:LiveEvent,now=Date.now()){return welcomeEligible(event,now);}
}

export interface WelcomeBridge {
  status:()=> 'unavailable'|'unknown'|'busy'|'ready';
  send:(event:LiveEvent,welcomeText?:string)=>boolean;
  receipt?:{requestId:string;status:string;reason?:string};
}
