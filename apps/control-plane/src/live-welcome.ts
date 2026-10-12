/** Optional, low priority welcome requests. No chat text or nickname ever enters the model. */
export const LIVE_WELCOME_TEXT='[BACKEND] LIVE WELCOME: A viewer entered the local Live Companion stream. This is not a task or a request to call tools. Only when the user and task reports are not speaking, say exactly once in Chinese: 嗨，你好，欢迎光临 . If busy, skip this welcome. Do not add names or any other words. Never retry it.';
export class LiveWelcomeGate {
  private seen=new Map<string,number>();
  private viewers=new Map<string,number>();
  private next=0;
  private work=0;
  beginWork(){this.work++;}
  endWork(){this.work=Math.max(0,this.work-1);this.touch();}
  quietAt=Date.now();
  touch(now=Date.now()){this.quietAt=now;}
  accept(input:Record<string,unknown>,busy:boolean,now=Date.now()):boolean {
    for(const map of [this.seen,this.viewers]){for(const [key,at] of map)if(now-at>=600000)map.delete(key);}
    if(input.kind!=='enter'||input.audioIdle!==true)return false;
    if(input.source!=='home-douyin-collector:companion-log'||input.streamEnabled!==true||input.nativeMethod!=='WebcastMemberMessage'||input.entryAction!=='1'||typeof input.sourceObservedAt!=='number'||!Number.isFinite(input.sourceObservedAt)||input.sourceObservedAt>now+5000||now-input.sourceObservedAt>20000)return false;
    if(!['roomId','eventId','viewerId','requestId'].every(key=>typeof input[key]==='string'&&/^[\w:-]{1,100}$/.test(input[key] as string)))return false;
    if(typeof input.observedAt!=='number'||!Number.isFinite(input.observedAt)||now-input.observedAt<0||now-input.observedAt>20000)return false;
    const key=`${input.roomId}:${input.eventId}`,viewer=`${input.roomId}:${input.viewerId}`;
    if(this.seen.size>=5000||this.viewers.size>=5000||this.work>0||busy||now<this.next||now-this.quietAt<5000||this.seen.has(key)||this.viewers.has(viewer))return false;
    // Reserve before sending. Unknown delivery must never be retried as a new greeting.
    this.seen.set(key,now);this.viewers.set(viewer,now);this.next=now+30000;return true;
  }
}
