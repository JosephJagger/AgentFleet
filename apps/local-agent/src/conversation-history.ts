import { AgentError } from './errors.js';
export interface ConversationMessage {id:string;turnId:string;role:'user'|'assistant';text:string;phase:string|null;time:number|string|null;timeSource:string;truncated:boolean;textOffset:number;textLength:number;}
export interface ConversationPage {nativeThreadId:string;cwd:string;turnId:string|null;turnStatus:string|null;items:ConversationMessage[];nextCursor:string|null;truncated:boolean;source:'codex_app_server';latestMessages?:ConversationMessage[];}
type Rpc=(method:string,params:Record<string,unknown>)=>Promise<unknown>;
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new AgentError('HISTORY_INVALID','Invalid native history');return v as Record<string,unknown>;};
/** Read only persisted turns; never resume, subscribe, start, or modify a thread. One turn per page. */
export async function readConversation(rpc:Rpc,threadId:string,cursor:string|null):Promise<ConversationPage> {
 let position:{page:string|null;offset:number;textOffset?:number;turn?:string}={page:null,offset:0};
 if(cursor!==null){try {position=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new AgentError('HISTORY_CURSOR_INVALID','Invalid history cursor');}
 if((position.page!==null&&typeof position.page!=='string')||!Number.isSafeInteger(position.offset)||position.offset<0||(position.textOffset!==undefined&&(!Number.isSafeInteger(position.textOffset)||position.textOffset<0))||(position.turn!==undefined&&typeof position.turn!=='string'))throw new AgentError('HISTORY_CURSOR_INVALID','Invalid history cursor');}
 cursor=position.page;
 const meta=object(object(await rpc('thread/read',{threadId,includeTurns:false})).thread);
 if(meta.id!==threadId||typeof meta.cwd!=='string')throw new AgentError('HISTORY_TARGET_CHANGED','Native history identity changed');
 let turn:Record<string,unknown>|undefined,nextCursor:string|null=null;
 if(meta.historyMode==='paginated') {
  const page=object(await rpc('thread/turns/list',{threadId,cursor,limit:1,sortDirection:'desc',itemsView:'full'}));
  if(!Array.isArray(page.data)||page.data.length>1||(page.nextCursor!=null&&(typeof page.nextCursor!=='string'||page.nextCursor.length>8192||page.nextCursor===cursor)))throw new AgentError('HISTORY_INVALID','Invalid native turn pagination');
  if(!page.data.length&&page.nextCursor)throw new AgentError('HISTORY_INVALID','Empty native page has a continuation');
  turn=page.data[0]===undefined?undefined:object(page.data[0]);nextCursor=typeof page.nextCursor==='string'?page.nextCursor:null;
 } else {
  const full=object(object(await rpc('thread/read',{threadId,includeTurns:true})).thread);
  if(full.id!==threadId||full.cwd!==meta.cwd||!Array.isArray(full.turns))throw new AgentError('HISTORY_TARGET_CHANGED','Native history identity changed');
  const turns=full.turns.map(object);let index=turns.length-1;
  if(cursor!==null){index=turns.findIndex(t=>t.id===cursor)-1;if(index< -1||!turns.some(t=>t.id===cursor))throw new AgentError('HISTORY_CURSOR_CHANGED','History cursor no longer exists');}
  turn=turns[index];nextCursor=index>0&&typeof turn?.id==='string'?turn.id:null;
 }
 if(!turn)return {nativeThreadId:threadId,cwd:meta.cwd,turnId:null,turnStatus:null,items:[],nextCursor:null,truncated:false,source:'codex_app_server'};
 if(typeof turn.id!=='string'||!Array.isArray(turn.items))throw new AgentError('HISTORY_INVALID','Native turn items not loaded');
 if(position.turn&&position.turn!==turn.id)throw new AgentError('HISTORY_CURSOR_CHANGED','Turn changed during pagination');
 const dialogue=turn.items.filter(value=>{const item=object(value);return ['userMessage','agentMessage'].includes(String(item.type));});
 const items:ConversationMessage[]=[];let truncated=false,characters=0,consumed=0,textContinuation:number|undefined;
 for(const value of dialogue.slice(position.offset)){const item=object(value);if(!['userMessage','agentMessage'].includes(String(item.type)))continue;
  if(typeof item.id!=='string')throw new AgentError('HISTORY_INVALID','Message identity missing');
  const text=item.type==='agentMessage'?(typeof item.text==='string'?item.text:''):Array.isArray(item.content)?item.content.map(v=>{const c=object(v);return c.type==='text'&&typeof c.text==='string'?c.text:`[${String(c.type??'attachment')}]`;}).join('\n'):'';
  if(items.length>=20||characters>=80000)break;
  const textOffset=consumed===0?(position.textOffset??0):0;
  if(textOffset>text.length)throw new AgentError('HISTORY_CURSOR_CHANGED','Message changed during pagination');
  const part=text.slice(textOffset,textOffset+20000);characters+=part.length;
  if(textOffset+part.length<text.length)textContinuation=textOffset+part.length;else consumed++;
  const time=item.createdAt??turn.startedAt??turn.createdAt;
  items.push({id:item.id,turnId:turn.id,role:item.type==='userMessage'?'user':'assistant',text:part,textOffset,textLength:text.length,phase:typeof item.phase==='string'?item.phase:null,time:typeof time==='string'||typeof time==='number'?time:null,timeSource:item.createdAt!=null?'native_item':time!=null?'native_turn':'unknown',truncated:textOffset>0||part.length<text.length});
  truncated ||=textOffset>0||part.length<text.length;
  if(textContinuation!==undefined)break;
 }
 // Latest pair is independent of the first context page: long commentary cannot hide the final reply.
 const latestUser=dialogue.findLast(value=>object(value).type==='userMessage');
 const latestFinal=dialogue.findLast(value=>{const item=object(value);return item.type==='agentMessage'&&item.phase==='final_answer';})??(turn.status==='completed'?dialogue.findLast(value=>{const item=object(value);return item.type==='agentMessage'&&item.phase!=='commentary';}):undefined);
 const latestMessages:ConversationMessage[]=[];
 for(const value of [latestUser,latestFinal])if(value){const item=object(value);
  const text=item.type==='agentMessage'?String(item.text??''):Array.isArray(item.content)?item.content.map(v=>{const c=object(v);return c.type==='text'?String(c.text??''):`[${String(c.type??'attachment')}]`;}).join('\n'):'';
  const time=item.createdAt??turn.startedAt??turn.createdAt;
  latestMessages.push({id:String(item.id),turnId:turn.id,role:item.type==='userMessage'?'user':'assistant',text:text.slice(0,20000),textOffset:0,textLength:text.length,phase:typeof item.phase==='string'?item.phase:null,time:typeof time==='string'||typeof time==='number'?time:null,timeSource:item.createdAt!=null?'native_item':time!=null?'native_turn':'unknown',truncated:text.length>20000});
 }
 const continuation=position.offset+consumed<dialogue.length?{page:position.page,offset:position.offset+consumed,turn:turn.id,...(textContinuation!==undefined?{textOffset:textContinuation}:{})}:nextCursor?{page:nextCursor,offset:0}:null;
 nextCursor=continuation?Buffer.from(JSON.stringify(continuation)).toString('base64url'):null;
 return {nativeThreadId:threadId,cwd:meta.cwd,turnId:turn.id,turnStatus:typeof turn.status==='string'?turn.status:null,items,nextCursor,truncated,source:'codex_app_server',latestMessages};
}
