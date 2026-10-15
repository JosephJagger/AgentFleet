import type {ControlPlaneDatabase} from './db.js';
import type {Principal} from './auth.js';
import type {PanelCall} from './panel-voice.js';
import {invariant} from './errors.js';
import {nowIso} from './crypto.js';

export const TRANSCRIPT_RETENTION_DAYS=30;
type TranscriptInput={text:string;role:string;final?:boolean;transcriptSeq?:number;transcriptSnapshot?:boolean;utteranceId?:string;utteranceSeq?:number;observedAt?:string;transcriptReplay?:boolean};
type Row={utterance_id:string;text:string;final:number;sequence:number;last_sequence:number;observed_at:string;role:string};
const isSearchRequest=(text:string)=>/^(?:(?:请|请帮我|帮我|麻烦你|麻烦|现在)[，,\s]*){0,3}(?:搜索|查找|查一下|找一下|检索|查一查)[\s\S]*(?:转写|通话|电话|语音|说过|说了|聊过|聊天)/.test(text.trim())||/^(?:please\s+)?(?:search|find|look up)\b[\s\S]*(?:transcript|call|said)/i.test(text.trim());
const isNewInstruction=(text:string)=>/^(?:(?:请|请帮我|帮我|现在)[，,\s]*){0,3}(?:执行|开始|开发|修改|发布|保存|取消|删除|停止|继续|接管|追加|安排)/.test(text.trim())||/^(?:please\s+)?(?:execute|start|develop|change|publish|save|cancel|delete|stop|continue|dispatch|take over)\b/i.test(text.trim());
const readActions=['transcript.search','live.chat.search','search','status','history','recover','preference.list'];
/** Search is opt-in, request-scoped and read-only. Storage never depends on search permission. */
export class VoiceTranscripts {
 constructor(private db:ControlPlaneDatabase){}
 settings(principal:Pick<Principal,'workspaceId'|'userId'>){
  const row=this.db.get<{enabled:number;revision:number}>('SELECT enabled,revision FROM voice_transcript_settings WHERE workspace_id=? AND user_id=?',principal.workspaceId,principal.userId);
  return {enabled:!!row?.enabled,revision:row?.revision??0,retentionDays:TRANSCRIPT_RETENTION_DAYS};
 }
 saveSettings(principal:Principal,input:Record<string,unknown>){
  invariant(typeof input.enabled==='boolean'&&Number.isSafeInteger(input.revision)&&Number(input.revision)>=0&&Object.keys(input).every(k=>['enabled','revision'].includes(k)),400,'TRANSCRIPT_SETTINGS_INPUT','搜索设置无效');
  return this.db.transaction(()=>{
   const previous=this.settings(principal);
   invariant(previous.revision===input.revision,409,'SETTINGS_REVISION_CONFLICT','设置已变化，请刷新后重试');
   this.db.run(`INSERT INTO voice_transcript_settings VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`,principal.workspaceId,principal.userId,input.enabled?1:0,previous.revision+1,nowIso());
   this.db.run('UPDATE voice_transcript_requests SET allowed=0 WHERE voice_id IN (SELECT voice_id FROM panel_voice_calls WHERE workspace_id=? AND user_id=?)',principal.workspaceId,principal.userId);
   this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,actorClientSessionId:principal.clientSessionId,action:'voice.transcript.search_permission',metadata:{enabled:input.enabled,revision:previous.revision+1}});
   return this.settings(principal);
  });
 }
 sequence(voiceId:string){return this.db.get<{sequence:number}>('SELECT sequence FROM voice_transcripts WHERE voice_id=? AND role=\'user\' ORDER BY last_sequence DESC LIMIT 1',voiceId)?.sequence??0;}
 record(call:PanelCall,input:TranscriptInput){
  invariant(['user','assistant'].includes(input.role)&&typeof input.text==='string',400,'TRANSCRIPT_INPUT','转写格式无效');
  const last=this.db.get<Row>('SELECT * FROM voice_transcripts WHERE voice_id=? AND role=? ORDER BY last_sequence DESC LIMIT 1',call.voice_id,input.role);
  const supplied=Number.isSafeInteger(input.transcriptSeq)&&Number(input.transcriptSeq)>0;
  const seq=supplied?input.transcriptSeq!:((this.db.get<{n:number}>('SELECT MAX(last_sequence) AS n FROM voice_transcripts WHERE voice_id=?',call.voice_id)?.n??0)+1);
  const modern=typeof input.utteranceId==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(input.utteranceId);
  const id=modern?input.utteranceId!:last&&!last.final?last.utterance_id:`compat:${input.role}:${seq}`;
  const old=this.db.get<Row>('SELECT * FROM voice_transcripts WHERE voice_id=? AND utterance_id=?',call.voice_id,id);
  // Old agents have only a user sequence and replay just their last snapshot.
  if(old&&old.last_sequence>=seq||!modern&&supplied&&last&&last.last_sequence>=seq)return;
  const text=input.final||input.transcriptSnapshot?input.text:(old?.text??'')+input.text;
  if(!text.trim())return;
  const at=nowIso();
  const observed=modern&&typeof input.observedAt==='string'&&Number.isFinite(Date.parse(input.observedAt))&&Math.abs(Date.parse(input.observedAt)-Date.now())<86400000?new Date(input.observedAt).toISOString():at;
  this.db.run(`INSERT INTO voice_transcripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(voice_id,utterance_id) DO UPDATE SET text=excluded.text,final=excluded.final,last_sequence=excluded.last_sequence,updated_at=excluded.updated_at`,call.voice_id,id,call.workspace_id,call.user_id,input.role,text,input.final?1:0,old?.sequence??(modern&&Number.isSafeInteger(input.utteranceSeq)&&Number(input.utteranceSeq)>0&&Number(input.utteranceSeq)<=seq?input.utteranceSeq!:seq),seq,old?.observed_at??observed,at,modern?'native':'compat_partial');
  if(input.role==='user'){
   const request=this.db.get<{sequence:number}>('SELECT sequence FROM voice_transcript_requests WHERE voice_id=?',call.voice_id);
   if(!request||seq>request.sequence){
    // Only fresh, final speech may authorize retrieval. Replays/assistant text/tool args cannot.
    const explicit=input.final&&!input.transcriptReplay&&modern&&isSearchRequest(text)&&!/(不要|别|禁止|不许|do not|don't)/i.test(text);
    this.db.run(`INSERT INTO voice_transcript_requests(voice_id,sequence,allowed,expires_at,read_only) VALUES(?,?,?,?,0) ON CONFLICT(voice_id) DO UPDATE SET sequence=excluded.sequence,allowed=excluded.allowed,expires_at=excluded.expires_at,read_only=CASE WHEN ? THEN 0 ELSE read_only END`,call.voice_id,seq,explicit&&this.settings({workspaceId:call.workspace_id,userId:call.user_id}).enabled?1:0,new Date(Date.now()+120000).toISOString(),input.final&&!input.transcriptReplay&&isNewInstruction(text)?1:0);
   }
  }
 }
 assertReadOnly(voiceId:string,action:string){
  invariant(!this.db.get('SELECT 1 FROM voice_transcript_requests WHERE voice_id=? AND read_only=1',voiceId)||readActions.includes(action),409,'TRANSCRIPT_READ_ONLY','历史转写仅供查询；执行操作需要用户新的明确指令');
 }
 search(principal:Principal,voiceId:string,input:Record<string,unknown>){
  invariant(this.settings(principal).enabled,403,'TRANSCRIPT_SEARCH_DISABLED','请先勾选支持搜索转写');
  const grant=this.db.get<{sequence:number}>('SELECT sequence FROM voice_transcript_requests WHERE voice_id=? AND allowed=1 AND expires_at>?',voiceId,nowIso());
  invariant(grant,403,'TRANSCRIPT_REQUEST_REQUIRED','请明确说“搜索通话转写中的…”后再查询；每次请求有效两分钟');
  const query=typeof input.query==='string'?input.query.trim():'';
  invariant(query.length>0&&query.length<=200,400,'TRANSCRIPT_QUERY_REQUIRED','请提供 1 至 200 字的搜索关键词');
  const cursor=input.cursor===undefined?Number.MAX_SAFE_INTEGER:Number(input.cursor);
  invariant(Number.isSafeInteger(cursor)&&cursor>0,400,'TRANSCRIPT_CURSOR','搜索游标无效');
  this.prune();
  const rows=this.db.all<Row&{rowid:number;voice_id:string;source:string}>(`SELECT rowid,* FROM voice_transcripts WHERE workspace_id=? AND user_id=? AND rowid<? AND observed_at>=? AND instr(lower(text),lower(?))>0 ORDER BY rowid DESC LIMIT 21`,principal.workspaceId,principal.userId,cursor,new Date(Date.now()-TRANSCRIPT_RETENTION_DAYS*86400000).toISOString(),query);
  this.db.run('UPDATE voice_transcript_requests SET read_only=1 WHERE voice_id=?',voiceId);
  this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,actorClientSessionId:principal.clientSessionId,action:'voice.transcript.search',metadata:{voiceId,count:Math.min(rows.length,20),requestSequence:grant.sequence}});
  return {source:'stored_voice_transcripts',untrustedData:true,executionAuthorized:false,retentionDays:TRANSCRIPT_RETENTION_DAYS,items:rows.slice(0,20).map(r=>{const offset=Math.max(0,r.text.toLowerCase().indexOf(query.toLowerCase())-500);return {voiceId:r.voice_id,id:r.utterance_id,role:r.role,time:r.observed_at,sequence:r.sequence,complete:!!r.final,source:r.source,text:r.text.slice(offset,offset+4000),offset,truncated:offset>0||r.text.length>4000};}),nextCursor:rows.length>20?String(rows[19]!.rowid):null};
 }
 prune(){this.db.run('DELETE FROM voice_transcripts WHERE observed_at<?',new Date(Date.now()-TRANSCRIPT_RETENTION_DAYS*86400000).toISOString());this.db.run("DELETE FROM voice_transcript_requests WHERE voice_id IN (SELECT voice_id FROM panel_voice_calls WHERE state='closed')");}
}
