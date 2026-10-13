import type {LiveEvent} from './live-interactions';
import {displayName} from './display-name';
/** Ephemeral upload queue. It never sends data into a model or starts speech. */
export class LiveChatUpload {
 private pending:LiveEvent[]=[];
 private controller:AbortController|null=null;
 private generation=0;
 private retryAt=0;
 private dropped=0;
 constructor(private send:(events:LiveEvent[],signal:AbortSignal)=>Promise<unknown>){}
 add(e:LiveEvent){if(e.type!=='chat'||!e.content.trim())return;if(this.pending.length>=100){this.pending.shift();this.dropped++;}this.pending.push({...e,name:displayName(e.name),content:displayName(e.content)});}
 clear(){this.generation++;this.controller?.abort();this.controller=null;this.pending=[];this.retryAt=0;this.dropped=0;}
 async flush():Promise<'saved'|'failed'|'partial'|null>{
  if(this.controller||Date.now()<this.retryAt)return null;
  this.pending=this.pending.filter(e=>(e.sourceObservedAt??0)>Date.now()-86400000);
  if(!this.pending.length)return null;
  const generation=this.generation,batch=this.pending.splice(0,20),controller=new AbortController();this.controller=controller;
  try{await this.send(batch,controller.signal);if(generation!==this.generation)return null;return this.dropped?'partial':'saved';}
  catch{if(generation!==this.generation)return null;const all=[...batch,...this.pending];this.dropped+=Math.max(0,all.length-100);this.pending=all.slice(-100);this.retryAt=Date.now()+5000;return 'failed';}
  finally{if(generation===this.generation)this.controller=null;}
 }
}
