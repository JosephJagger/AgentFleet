/** Optional, low priority welcome requests. No chat text or nickname ever enters the model. */
export const LIVE_WELCOME_TEXT='[BACKEND] LIVE WELCOME: A viewer entered the local Live Companion stream. This is not a task or a request to call tools. Say exactly once in Chinese: 嗨，你好，欢迎光临 . The user may interrupt through native voice; do not restart an interrupted welcome. Do not add names or any other words. Never retry it.';
export class LiveWelcomeGate {
  rejectionReason='';
  private reject(reason:string){this.rejectionReason=reason;return false;}
  private seen=new Map<string,number>();
  private viewers=new Map<string,number>();
  private next=0;
  private work=0;
  beginWork(){this.work++;}
  endWork(){this.work=Math.max(0,this.work-1);}
  accept(input:Record<string,unknown>,busy:boolean,now=Date.now()):boolean {
    this.rejectionReason='';
    for(const map of [this.seen,this.viewers]){for(const [key,at] of map)if(now-at>=600000)map.delete(key);}
    if(input.kind!=='enter'||input.nativeInterruptible!==true)return this.reject('protocol');
    if(input.source!=='home-douyin-collector:companion-log'||input.streamEnabled!==true||input.nativeMethod!=='WebcastMemberMessage'||input.entryAction!=='1' )return this.reject('protocol');
    if(typeof input.sourceObservedAt!=='number'||!Number.isFinite(input.sourceObservedAt)||input.sourceObservedAt>now+5000||now-input.sourceObservedAt>20000)return this.reject('event_time');
    if(!['roomId','eventId','viewerId','requestId'].every(key=>typeof input[key]==='string'&&/^[\w:-]{1,100}$/.test(input[key] as string)))return this.reject('identifiers');
    if(typeof input.observedAt!=='number'||!Number.isFinite(input.observedAt)||input.observedAt>now+5000||now-input.observedAt>20000)return this.reject('event_time');
    const key=`${input.roomId}:${input.eventId}`,viewer=`${input.roomId}:${input.viewerId}`;
    if(busy)return this.reject('task_priority');
    if(this.work>0)return this.reject('tool_active');
    if(this.seen.has(key))return this.reject('duplicate_event');
    if(this.viewers.has(viewer))return this.reject('repeat_viewer');
    if(now<this.next)return this.reject('cooldown');
    if(this.seen.size>=5000||this.viewers.size>=5000)return this.reject('capacity');
    // Reserve before sending. Unknown delivery must never be retried as a new greeting.
    this.seen.set(key,now);this.viewers.set(viewer,now);this.next=now+30000;return true;
  }
}
