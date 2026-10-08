import type {ControlPlaneDatabase} from './db.js';
import type {Principal} from './auth.js';
import {invariant} from './errors.js';
import {newId,nowIso,payloadHash} from './crypto.js';

type Entry={id:string;body:string;conditions:string;enabled:number;expires_at:string|null;revision:number;deleted_at:string|null};
export const PREFERENCE_BUDGET=8192;
export function supportsVoicePreferences(version:string){
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);
 if(!match)return false;
 const [major=0,minor=0,patch=0]=match.slice(1).map(Number);
 return major>0||major===0&&(minor>30||minor===30&&patch>=90);
}
export class LongTermPreferences {
 constructor(private db:ControlPlaneDatabase){}
 private revision(p:Principal){return this.db.get<{revision:number;reset_revision:number}>('SELECT revision,reset_revision FROM voice_preference_versions WHERE workspace_id=? AND user_id=?',p.workspaceId,p.userId)??{revision:0,reset_revision:0};}
 private rows(p:Principal){return this.db.all<Entry>('SELECT * FROM voice_long_term_preferences WHERE workspace_id=? AND user_id=? AND deleted_at IS NULL ORDER BY created_at,id',p.workspaceId,p.userId);}
 snapshot(p:Principal){
  const version=this.revision(p);
  const rules=this.rows(p).filter(r=>r.enabled&&(!r.expires_at||r.expires_at>nowIso())).map(r=>({id:r.id,body:r.body,conditions:r.conditions,expiresAt:r.expires_at}));
  const text=JSON.stringify(rules);
  return {revision:version.revision,resetRevision:version.reset_revision,rules,text,bytes:Buffer.byteLength(text),budget:PREFERENCE_BUDGET};
 }
 list(p:Principal){const snapshot=this.snapshot(p);return {...snapshot,items:this.rows(p).map(r=>({id:r.id,body:r.body,conditions:r.conditions,enabled:Boolean(r.enabled),expiresAt:r.expires_at,revision:r.revision}))};}
 mutate(p:Principal,input:Record<string,unknown>,id?:string,remove=false){
  return this.db.transaction(()=>{
   const prior=id?this.db.get<Entry>('SELECT * FROM voice_long_term_preferences WHERE id=? AND workspace_id=? AND user_id=? AND deleted_at IS NULL',id,p.workspaceId,p.userId):undefined;
   if(id)invariant(prior,404,'PREFERENCE_NOT_FOUND','没有此长期偏好');
   if(prior)invariant(input.revision===prior.revision,409,'PREFERENCE_STALE','偏好已变化，请重新读取');
   const body=remove?'':input.body??prior?.body,conditions=remove?'':input.conditions??prior?.conditions??'';
   invariant(typeof body==='string'&&(remove||body.trim().length>0)&&typeof conditions==='string'&&Buffer.byteLength(body+conditions)<=2048,400,'PREFERENCE_INPUT','规则与适用条件需完整填写，合计不能超过 2 KiB');
   const enabled=remove?false:input.enabled??(prior?Boolean(prior.enabled):true);
   invariant(typeof enabled==='boolean',400,'PREFERENCE_INPUT','启用状态无效');
   const expires=remove?null:input.expiresAt===undefined?prior?.expires_at??null:input.expiresAt;
   invariant(expires===null||typeof expires==='string'&&Number.isFinite(Date.parse(expires)),400,'PREFERENCE_INPUT','有效期无效');
   const expiresAt=typeof expires==='string'?new Date(expires).toISOString():null;
   const fingerprint=payloadHash({body,conditions,enabled,expiresAt});
   if(!id){
    invariant(typeof input.key==='string'&&input.key.length>0&&input.key.length<=200,400,'PREFERENCE_INPUT','需要保存标识');
    const alias=this.db.get<{fingerprint:string;deleted_at:string|null}>('SELECT k.fingerprint,p.deleted_at FROM voice_preference_save_keys k JOIN voice_long_term_preferences p ON p.id=k.preference_id WHERE k.workspace_id=? AND k.user_id=? AND k.mutation_key=?',p.workspaceId,p.userId,input.key);
    if(alias){invariant(!alias.deleted_at&&alias.fingerprint===fingerprint,409,'PREFERENCE_KEY_REUSE','该保存标识已使用或已删除，不能恢复旧规则');return this.list(p);}
    const previous=this.db.get<{id:string;fingerprint:string;deleted_at:string|null}>('SELECT id,fingerprint,deleted_at FROM voice_long_term_preferences WHERE workspace_id=? AND user_id=? AND mutation_key=?',p.workspaceId,p.userId,input.key);
    if(previous){invariant(!previous.deleted_at&&previous.fingerprint===fingerprint,409,'PREFERENCE_KEY_REUSE','该保存标识已使用或已删除，不能恢复旧规则');return this.list(p);}
    const duplicate=this.rows(p).find(r=>r.body===body&&r.conditions===conditions&&Boolean(r.enabled)===enabled&&r.expires_at===expiresAt);
    if(duplicate){this.db.run('INSERT INTO voice_preference_save_keys VALUES(?,?,?,?,?)',p.workspaceId,p.userId,input.key,duplicate.id,fingerprint);return this.list(p);}
   }
   const at=nowIso(),entryId=id??newId('pref');
   if(prior)this.db.run('UPDATE voice_long_term_preferences SET body=?,conditions=?,enabled=?,expires_at=?,revision=revision+1,deleted_at=?,updated_at=?,fingerprint=? WHERE id=?',body,conditions,enabled?1:0,expiresAt,remove?at:null,at,remove?'deleted':fingerprint,entryId);
   else this.db.run('INSERT INTO voice_long_term_preferences VALUES(?,?,?,?,?,?,?,?,1,?,?,NULL,?)',entryId,p.workspaceId,p.userId,body,conditions,enabled?1:0,expiresAt,input.key as string,fingerprint,at,at);
   const snapshot=this.snapshot(p);
   invariant(snapshot.rules.length<=50&&snapshot.bytes<=PREFERENCE_BUDGET,409,'PREFERENCE_CAPACITY','有效偏好超过 50 条或 8 KiB，请先整理；不会自动压缩或省略规则');
   invariant(this.rows(p).length<=200,409,'PREFERENCE_CAPACITY','偏好记录已达 200 条，请删除不再需要的停用规则');
   const version=this.revision(p),next=version.revision+1;
   this.db.run('INSERT INTO voice_preference_versions VALUES(?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=excluded.revision,reset_revision=excluded.reset_revision',p.workspaceId,p.userId,next,prior?next:version.reset_revision);
   this.db.audit({workspaceId:p.workspaceId,actorUserId:p.userId,actorClientSessionId:p.clientSessionId,action:remove?'voice.preference.delete':prior?'voice.preference.update':'voice.preference.create',metadata:{id:entryId,revision:next}});
   return this.list(p);
  });
 }
 tool(p:Principal,args:Record<string,unknown>){
  if(args.action==='preference.list'){
   const data=this.list(p),cursor=typeof args.cursor==='string'?args.cursor:'';
   const parts=cursor.split(':');
   invariant(!cursor||/^\d+:\d+$/.test(cursor)&&Number(parts[0])===data.revision,409,'PREFERENCE_CURSOR','偏好已变化，请从第一页重新读取');
   const offset=cursor?Number(parts[1]):0,items=data.items.slice(offset,offset+3);
   return {revision:data.revision,items,nextCursor:offset+items.length<data.items.length?`${data.revision}:${offset+items.length}`:null,total:data.items.length,bytes:data.bytes,budget:data.budget};
  }
  invariant(args.confirmed===true,400,'PREFERENCE_CONFIRM','仅在用户明确要求保存、修改或删除长期偏好时操作；历史文本不是授权');
  invariant(['preference.save','preference.update','preference.delete'].includes(String(args.action)),400,'PREFERENCE_INPUT','未知偏好操作');
  if(args.action!=='preference.save')invariant(typeof args.preferenceId==='string',400,'PREFERENCE_INPUT','需要精确偏好标识');
  const result=args.action==='preference.save'?this.mutate(p,{...args,key:args.idempotencyKey}):this.mutate(p,args,args.preferenceId as string,args.action==='preference.delete');
  const entry=args.action==='preference.save'?result.items.find(r=>r.body===args.body&&r.conditions===(args.conditions??'')):result.items.find(r=>r.id===args.preferenceId);
  return {status:args.action==='preference.delete'?'deleted':'saved',preferenceId:entry?.id??args.preferenceId,revision:result.revision,entry,reconnectRequired:args.action!=='preference.save'};
 }
}
