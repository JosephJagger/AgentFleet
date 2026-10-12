/** Adapter for DouyinBarrageGrab's documented JSON WebSocket stream, not an official Douyin API. */
export interface LiveEvent {
  id:string; roomId:string; ownerId:string; ownerName:string; roomTitle:string;
  userId:string; name:string; content:string; type:'chat'|'enter'|'start'|'end'; receivedAt:number;
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
const identifier=(v:unknown)=>typeof v==='string'&&/^[\w:-]{1,100}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):'';
// Newtonsoft emits 64-bit numeric IDs. Never round them through JS Number.
function json(raw:string):unknown {
  return JSON.parse(raw.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(token,quoted)=>quoted?token:/^-?\d{16,}$/.test(token)?JSON.stringify(token):token));
}
export function parseLiveEvent(raw:string,now=Date.now()):LiveEvent|null {
  if(raw.length>65536)return null;
  try {
    const pack=object(json(raw));
    if(!['直播伴侣','直播伴侣.exe'].includes(String(pack.ProcessName)))return null;
    if(![1,3,9,101,102].includes(pack.Type as number))return null;
    const data=object(typeof pack.Data==='string'?json(pack.Data):pack.Data),user=object(data.User),owner=object(data.Owner);
    const type=pack.Type===1?'chat':pack.Type===3?'enter':pack.Type===101?'start':'end';
    const roomId=identifier(data.RoomId),ownerId=identifier(owner.UserId);
    if(!roomId||!ownerId&&type!=='end')return null; // No guessed room or owner; web room IDs may be absent.
    const id=identifier(data.MsgId),userId=identifier(user.Id);
    if((type==='chat'||type==='enter')&&(!id||!userId||data.IsAnonymous===true))return null;
    if(type==='enter'&&user.IsAnchor===true)return null;
    return {type,id,roomId,ownerId,ownerName:text(owner.Nickname),roomTitle:text(data.RoomTitle),userId,name:text(user.Nickname),content:type==='chat'?text(data.Content,2000):'',receivedAt:now};
  }catch{return null;}
}
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
  welcome(event:LiveEvent){if(event.type!=='enter')return false;this.prune(this.viewers,event.receivedAt);const key=`${event.roomId}:${event.userId}`;if(this.viewers.has(key)||this.viewers.size>=5000)return false;this.viewers.set(key,event.receivedAt);return true;}
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
