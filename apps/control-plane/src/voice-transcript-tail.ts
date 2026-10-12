import type {ControlPlaneDatabase} from './db.js';
import type {Principal} from './auth.js';
import type {PanelCall} from './panel-voice.js';
import type {VoiceTaskStore} from './voice-task-store.js';
import {invariant} from './errors.js';
import {nowIso} from './crypto.js';

/** Last received user utterance only. A transcript is never execution authorization. */
export class VoiceTranscriptTail {
 constructor(private db:ControlPlaneDatabase,private memory:VoiceTaskStore){}
 record(call:PanelCall,input:{text:string;final?:boolean;transcriptSeq?:number;transcriptSnapshot?:boolean}) {
  const previous=this.db.get<{text:string;final:number;sequence:number;segment:number;revision:number}>('SELECT * FROM panel_voice_tails WHERE voice_id=?',call.voice_id);
  const sequence=typeof input.transcriptSeq==='number'&&Number.isSafeInteger(input.transcriptSeq)&&input.transcriptSeq>0?input.transcriptSeq!: (previous?.sequence??0)+1;
  if(previous&&sequence<=previous.sequence)return;
  const text=(input.final||input.transcriptSnapshot?input.text:(previous?.final?'':previous?.text??'')+input.text).slice(-8000);
  if(!text.trim())return;
  const segment=previous&&!previous.final?previous.segment:sequence;
  this.db.run(`INSERT INTO panel_voice_tails(voice_id,workspace_id,user_id,text,final,sequence,segment,revision,state,review,receipt_json,updated_at)
   VALUES(?,?,?,?,?,?,?,1,'pending',0,NULL,?) ON CONFLICT(voice_id) DO UPDATE SET text=excluded.text,final=excluded.final,sequence=excluded.sequence,segment=excluded.segment,
   revision=revision+1,state='pending',receipt_json=CASE WHEN panel_voice_tails.final=0 THEN panel_voice_tails.receipt_json ELSE NULL END,updated_at=excluded.updated_at`,
   call.voice_id,call.workspace_id,call.user_id,text,input.final?1:0,sequence,segment,nowIso());
  this.updateDraft(call.voice_id,false);
 }
 private updateDraft(voiceId:string,create:boolean){
  const row=this.db.get<{text:string;final:number;sequence:number;segment:number;workspace_id:string;user_id:string;receipt_json:string|null;updated_at:string}>('SELECT * FROM panel_voice_tails WHERE voice_id=?',voiceId);if(!row)return;
  const id=`${voiceId}:${row.segment}`;
  if(!create&&!this.db.get('SELECT 1 FROM panel_voice_tail_drafts WHERE id=?',id))return;
  this.db.run(`INSERT INTO panel_voice_tail_drafts VALUES(?,?,?,?,?,?,?,1,'pending',?,?)
   ON CONFLICT(id) DO UPDATE SET text=excluded.text,final=excluded.final,sequence=excluded.sequence,revision=revision+1,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at
   WHERE panel_voice_tail_drafts.state='pending' AND (panel_voice_tail_drafts.sequence<excluded.sequence OR panel_voice_tail_drafts.receipt_json IS NOT excluded.receipt_json)`,
   id,voiceId,row.workspace_id,row.user_id,row.text,row.final,row.sequence,row.receipt_json,row.updated_at);
 }
 review(id:string){this.updateDraft(id,true);}
 receipt(id:string,sequence:number|undefined,result:Record<string,unknown>){
  if(sequence===undefined||(!result.jobId&&!result.commandId&&!result.todoId))return;
  this.db.run('UPDATE panel_voice_tails SET receipt_json=? WHERE voice_id=? AND sequence=?',JSON.stringify({jobId:result.jobId,commandId:result.commandId,todoId:result.todoId,sessionId:result.sessionId}),id,sequence);
  this.updateDraft(id,false);
 }
 sequence(id:string){return this.db.get<{sequence:number}>('SELECT sequence FROM panel_voice_tails WHERE voice_id=?',id)?.sequence;}
 prune(){const before=new Date(Date.now()-7*86400000).toISOString();this.db.run('DELETE FROM panel_voice_tails WHERE updated_at < ?',before);this.db.run('DELETE FROM panel_voice_tail_drafts WHERE updated_at < ?',before);}
 list(principal:Principal){
  this.prune();
  return this.db.all<{id:string;text:string;final:number;revision:number;receipt_json:string|null;updated_at:string}>(
   "SELECT * FROM panel_voice_tail_drafts WHERE workspace_id=? AND user_id=? AND state='pending' ORDER BY updated_at DESC LIMIT 20",principal.workspaceId,principal.userId)
   .map(row=>({id:row.id,text:row.text,complete:Boolean(row.final),revision:row.revision,receipt:row.receipt_json?JSON.parse(row.receipt_json):null,updatedAt:row.updated_at}));
 }
 resolve(principal:Principal,id:string,input:Record<string,unknown>){return this.db.transaction(()=>{
  const row=this.db.get<{voice_id:string;revision:number;state:string;receipt_json:string|null}>("SELECT * FROM panel_voice_tail_drafts WHERE id=? AND workspace_id=? AND user_id=?",id,principal.workspaceId,principal.userId);
  invariant(row,404,'VOICE_TAIL_NOT_FOUND','没有此待确认转写');
  invariant(row.state==='pending'&&row.revision===input.revision,409,'VOICE_TAIL_STALE','转写已变化，请重新读取');
  invariant(input.action==='save'||input.action==='discard',400,'VOICE_TAIL_INPUT','请选择保存或丢弃');
  let todo;
  if(input.action==='save'){
   invariant(input.confirmed===true,400,'VOICE_TAIL_CONFIRM','请检查转写并明确确认');
   invariant(!row.receipt_json,409,'VOICE_TAIL_RECEIPT','此转写已有任务或待办回执，请先查询原记录，不能重复保存执行');
   todo=this.memory.save(principal,{intent:input.text,key:`tail:${id}:${row.revision}`},row.voice_id);
  }
  this.db.run("UPDATE panel_voice_tail_drafts SET state=?,text='',revision=revision+1 WHERE id=?",input.action==='save'?'saved':'discarded',id);
  return {todoId:todo?.todo_id??null,savedOnly:Boolean(todo),dispatched:false};
 });}
}
