/** Adapter for DouyinBarrageGrab's documented JSON WebSocket stream, not an official Douyin API. */
export interface LiveEvent {
  id:string; roomId:string; ownerId:string; ownerName:string; roomTitle:string;
  userId:string; name:string; content:string; type:'chat'|'enter'|'start'|'end'|'room'; receivedAt:number; anonymous?:boolean; isAnchor?:boolean;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
const identifier=(v:unknown)=>typeof v==='string'&&/^[\w:-]{1,100}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):'';
// Newtonsoft emits 64-bit numeric IDs. Never round them through JS Number.
function json(raw:string):unknown {
  return JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(token,quoted)=>quoted?token:/^-?\d{16,}$/.test(token)?JSON.stringify(token):token));
}
export type CollectorRejection='binary'|'oversize'|'format'|'source'|'unsupported'|'room'|'message';
export type CollectorPacket={event:LiveEvent;reason?:never}|{event?:never;reason:CollectorRejection};
/** Decode the documented envelope before deciding whether it is suitable for display or voice. */
export function inspectLivePacket(raw:unknown,now=Date.now()):CollectorPacket {
  if(typeof raw!=='string')return {reason:'binary'};
  if(raw.length>65536)return {reason:'oversize'};
  try {
    const pack=object(json(raw));
    if(!('Type' in pack)||!('Data' in pack))return {reason:'format'};
    if(!['直播伴侣','直播伴侣.exe'].includes(String(pack.ProcessName)))return {reason:'source'};
    if(![1,3,6,9,101,102].includes(pack.Type as number))return {reason:'unsupported'};
    const data=object(typeof pack.Data==='string'?json(pack.Data):pack.Data),user=object(data.User);
    // Lifecycle Data contains RoomInfo even when AttachRoomInfo has not filled the outer Owner.
    const info=pack.Type===101?object(data.Data):{};
    const owner=object(data.Owner??info.Owner);
    const type=pack.Type===1?'chat':pack.Type===3?'enter':pack.Type===6?'room':pack.Type===101?'start':'end';
    const roomId=identifier(data.RoomId),ownerId=identifier(owner.UserId);
    if(!roomId)return {reason:'room'};
    const id=identifier(data.MsgId),userId=identifier(user.Id);
    if((type==='chat'||type==='enter')&&!id)return {reason:'message'};
    if(type==='chat'&&typeof data.Content!=='string')return {reason:'message'};
    return {event:{type,id,roomId,ownerId,ownerName:text(owner.Nickname),roomTitle:text(data.RoomTitle)||text(info.Title),userId,name:text(user.Nickname),content:type==='chat'?text(data.Content,2000):'',receivedAt:now,anonymous:data.IsAnonymous===true,isAnchor:user.IsAnchor===true}};
  }catch{return {reason:'format'};}
}
export function parseLiveEvent(raw:string,now=Date.now()):LiveEvent|null {
  return inspectLivePacket(raw,now).event??null;
}
export interface CollectorDiagnostics {
  packets:number;chat:number;enter:number;metadata:number;rejected:number;missingOwner:number;lastPacketAt:number;
  reasons:Partial<Record<CollectorRejection,number>>;
}
export const emptyCollectorDiagnostics=():CollectorDiagnostics=>({packets:0,chat:0,enter:0,metadata:0,rejected:0,missingOwner:0,lastPacketAt:0,reasons:{}});
/** Per socket, bounded metadata cache. Never borrow ownership across rooms or connections. */
export class LiveCollectorStream {
  diagnostics=emptyCollectorDiagnostics();
  private rooms=new Map<string,LiveEvent>();
  read(raw:unknown,now=Date.now()):CollectorPacket {
    const d=this.diagnostics;d.packets++;d.lastPacketAt=now;
    const result=inspectLivePacket(raw,now);
    if(!result.event){d.rejected++;d.reasons[result.reason]=(d.reasons[result.reason]??0)+1;return result;}
    let event=result.event;
    if(event.type==='chat')d.chat++;else if(event.type==='enter')d.enter++;else d.metadata++;
    const previous=this.rooms.get(event.roomId);
    if(event.type==='end'){this.rooms.delete(event.roomId);return result;}
    if(event.type!=='start'&&previous&&(!event.ownerId||event.ownerId===previous.ownerId)){
      event={...event,ownerId:event.ownerId||previous.ownerId,ownerName:event.ownerName||previous.ownerName,roomTitle:event.roomTitle||previous.roomTitle};
    }
    if(!event.ownerId)d.missingOwner++;
    this.rooms.delete(event.roomId);
    this.rooms.set(event.roomId,event);
    if(this.rooms.size>5)this.rooms.delete(this.rooms.keys().next().value!);
    return {event};
  }
}
/** A local fresh chat marker helps the user compare a room, not authenticate a Douyin account. */
export class LiveRoomMarker {
  private value='';private until=0;private matched='';
  create(now=Date.now()) {this.value=`AF-${crypto.randomUUID()}`;this.until=now+300000;this.matched='';return this.value;}
  observe(event:LiveEvent,now=Date.now()) {if(this.value&&now<=this.until&&event.type==='chat'&&event.content.trim()===this.value)this.matched=event.roomId;}
  matches(roomId:string,now=Date.now()){return Boolean(this.value&&now<=this.until&&this.matched===roomId);}
  clear(){this.value='';this.until=0;this.matched='';}
}
export function welcomeEligible(event:LiveEvent) {return event.type==='enter'&&Boolean(event.ownerId&&event.userId)&&event.userId!==event.ownerId&&!event.anonymous&&!event.isAnchor;}
export function localCollectorUrl(port:string) {
  if(!/^\d{1,5}$/.test(port)||Number(port)<1024||Number(port)>65535)throw new Error('Invalid local port');
  return `ws://127.0.0.1:${Number(port)}/`;
}
export const sameRoom=(a:Pick<LiveEvent,'roomId'|'ownerId'>,b:Pick<LiveEvent,'roomId'|'ownerId'>)=>a.roomId===b.roomId&&a.ownerId===b.ownerId;

/** Bounded receive ledger, independent of the visible 100 messages and welcome toggle. */
export class LiveEventLedger {
  private seen=new Map<string,number>();
  private viewers=new Map<string,number>();
  private prune(map:Map<string,number>,now:number){for(const [key,at] of map)if(now-at>=600000)map.delete(key);}
  accept(event:LiveEvent){this.prune(this.seen,event.receivedAt);const key=`${event.roomId}:${event.type}:${event.id}`;if(this.seen.has(key))return false;if(this.seen.size>=5000)this.seen.delete(this.seen.keys().next().value!);this.seen.set(key,event.receivedAt);return true;}
  welcome(event:LiveEvent){if(!welcomeEligible(event))return false;this.prune(this.viewers,event.receivedAt);const key=`${event.roomId}:${event.userId}`;if(this.viewers.has(key)||this.viewers.size>=5000)return false;this.viewers.set(key,event.receivedAt);return true;}
}

/** Observe only; never cancel audio or send messages on the native data channel. */
export class WelcomeAudioGate {
  known=false; private inputKnown=false; private outputKnown=false; user=false; response=false; output=false; quietSince=Date.now();
  event(raw:unknown,now=Date.now()) {
    const type=object(raw).type;
    if(type==='input_audio_buffer.speech_started'){this.inputKnown=true;this.user=true;this.response=true;}
    else if(type==='input_audio_buffer.speech_stopped'){this.inputKnown=true;this.user=false;}
    else if(type==='response.created'){this.response=true;}
    else if(type==='response.done'){this.response=false;}
    else if(type==='output_audio_buffer.started'){this.outputKnown=true;this.output=true;}
    else if(type==='output_audio_buffer.stopped'||type==='output_audio_buffer.cleared'){this.outputKnown=true;this.output=false;}
    else return;
    this.known=this.inputKnown&&this.outputKnown;
    this.quietSince=now;
  }
  busy(now=Date.now()){return !this.known||this.user||this.response||this.output||now-this.quietSince<5000;}
}
export interface WelcomeBridge {
  status:()=> 'unavailable'|'unknown'|'busy'|'ready';
  send:(event:LiveEvent)=>boolean;
  receipt?:{requestId:string;status:string};
}
