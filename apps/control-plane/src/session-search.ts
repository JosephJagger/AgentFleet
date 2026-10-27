import pg from 'pg';
import type { SQLInputValue } from 'node:sqlite';
import type { ControlPlaneDatabase } from './db.js';
import type { Principal } from './auth.js';
import { invariant } from './errors.js';
import { postgresSql } from './postgres-sql.js';

type Row = { id:string; title:string; machineId:string; machineName:string; hostname:string; projectId:string; project:string; path:string; provider:string; managed:number; updatedAt:string; state:string; online:number; syncContent:number };
type Hit = { id:string; eventId:string; text:string; role:string; quotedText?:string };
type Reader = <T extends object>(sql:string, values:SQLInputValue[])=>Promise<T[]>;
const FROM = `FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id JOIN projects p ON p.project_id=s.project_id`;
const SCOPE = `s.workspace_id=? AND m.workspace_id=s.workspace_id AND p.workspace_id=s.workspace_id AND m.identity_state='active' AND s.deleted_at IS NULL`;
const BASE_CONTENT = `e.workspace_id=s.workspace_id AND b.workspace_id=s.workspace_id AND e.content_epoch=s.content_epoch AND e.type='item.completed' AND e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at>? AND p.sync_content=1
  AND NOT EXISTS(SELECT 1 FROM content_tombstones t WHERE t.event_id=e.event_id)
`;
const CONTENT = BASE_CONTENT+` AND EXISTS (SELECT 1 FROM latest l WHERE l.logical_session_id=e.logical_session_id AND l.content_epoch=e.content_epoch AND l.item_id=coalesce(e.native_item_id,e.event_id) AND l.seq=e.session_seq)`;
const LOCATION = `lower(s.title || ' ' || p.alias || ' ' || p.canonical_root || ' ' || coalesce(s.session_cwd,'') || ' ' || m.name || ' ' || coalesce(m.display_alias,'') || ' ' || p.provider)`;
const SQLITE_ITEM_TYPE = `json_extract(b.body_json,'$.item.type')`;

const fold = (text:string) => text.toLowerCase().trim();
export function searchTerms(query:string) { return [...new Set(fold(query).split(/\s+/u).filter(Boolean))]; }
function oneEdit(a:string,b:string) {
  if(Math.abs(a.length-b.length)>1)return false;
  let i=0,j=0,edits=0;
  while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}
  return edits+(i<a.length||j<b.length?1:0)<=1;
}
function fuzzyTitle(title:string,term:string) {
  if(term.length<2||term.length>80)return false;
  if(/^[a-z0-9]{4,}$/i.test(term)&&title.split(/[^a-z0-9]+/).some(word=>oneEdit(word,term)))return true;
  // Ordered, nearby characters also match abbreviated Chinese titles. Never call this semantic search.
  let previous=-1,first=-1;
  for(const character of term){const next=title.indexOf(character,previous+1);if(next<0||previous>=0&&next-previous>5)return false;if(first<0)first=next;previous=next;}
  return previous-first+1<=term.length*3;
}
export function metadataScore(row:Pick<Row,'title'|'machineName'|'hostname'|'project'|'path'|'provider'>,query:string,terms:string[]) {
  if(!query)return 1;
  const title=fold(row.title),location=fold([row.machineName,row.hostname,row.project,row.path,row.provider].join(' '));
  if(title===query)return 120;
  if(title.includes(query))return 110;
  if(terms.every(term=>title.includes(term)))return 100;
  if(terms.every(term=>title.includes(term)||location.includes(term)))return 75;
  if(terms.every(term=>title.includes(term)||location.includes(term)||fuzzyTitle(title,term)))return 35;
  return 0;
}
export function searchSnippet(text:string,terms:string[]) {
  const value=text.replace(/\u0000/g,'�').replace(/\s+/gu,' ').trim(),lower=fold(value);
  const positions=terms.map(term=>lower.indexOf(term)).filter(index=>index>=0);
  const start=Math.max(0,(positions.length?Math.min(...positions):0)-55),end=Math.min(value.length,start+240);
  return `${start?'…':''}${value.slice(start,end)}${end<value.length?'…':''}`;
}

/** Read-only, no embedding provider, no secondary copy of retained conversation content.
 * PostgreSQL searches use their own bounded async pool so a large history cannot block
 * heartbeat, event ingress, or command dispatch on the synchronous primary connection. */
export class SessionSearchService {
  private pool:pg.Pool|undefined;
  private read:Reader;
  private active=0;
  constructor(private db:ControlPlaneDatabase,postgres?:{url:string;schema?:string}) {
    if(postgres){
      const schema=postgres.schema??'public';
      if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid search schema');
      this.pool=new pg.Pool({connectionString:postgres.url,max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,
        application_name:'agentfleets-session-search',options:`-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=4000`});
      // An idle connection failure must not take down command processing. The next query reconnects.
      this.pool.on('error',()=>{});
      this.read=async <T extends object>(sql:string,values:SQLInputValue[]) => (await this.pool!.query(postgresSql(sql,values),values)).rows as T[];
    }else this.read=async <T extends object>(sql:string,values:SQLInputValue[])=>db.all<T>(sql,...values);
  }
  async close(){await this.pool?.end();}
  async search(principal:Principal,input:Record<string,unknown>,signal?:AbortSignal) {
    invariant(input.q===undefined||typeof input.q==='string',400,'SEARCH_INPUT','搜索内容无效');
    const query=fold(String(input.q??'')),terms=searchTerms(query);
    invariant(query.length<=160&&terms.length<=8,400,'SEARCH_INPUT','请使用不超过 160 字、8 个关键词的搜索');
    const offset=Number(input.offset??0),limit=Number(input.limit??20);
    invariant(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=40,400,'SEARCH_INPUT','搜索分页无效');
    for(const key of ['machineId','provider'])invariant(input[key]===undefined||typeof input[key]==='string'&&String(input[key]).length<=200,400,'SEARCH_INPUT','搜索筛选无效');
    invariant(input.managed===undefined||input.managed==='true',400,'SEARCH_INPUT','搜索筛选无效');
    invariant(this.active<8,429,'SEARCH_BUSY','搜索繁忙，请稍后重试');
    this.active++;
    const read=async <T extends object>(sql:string,values:SQLInputValue[])=>{signal?.throwIfAborted();const rows=await this.read<T>(sql,values);signal?.throwIfAborted();return rows;};
    try {
      const filters=[SCOPE],values:SQLInputValue[]=[principal.workspaceId];
      if(input.machineId){filters.push('s.machine_id=?');values.push(String(input.machineId));}
      if(input.provider){filters.push('p.provider=?');values.push(String(input.provider));}
      if(input.managed==='true')filters.push('s.managed=1');
      const where=filters.join(' AND '),now=new Date().toISOString();
      // Rank message revisions once, avoiding a correlated history scan for every
      // match in long sessions. Hidden newer revisions still suppress older text.
      const latest=(ids?:string[])=>`WITH latest AS (SELECT logical_session_id,content_epoch,coalesce(native_item_id,event_id) AS item_id,max(session_seq) AS seq FROM durable_events WHERE workspace_id=? AND type='item.completed'${ids?.length?` AND logical_session_id IN (${ids.map(()=>'?').join(',')})`:''} GROUP BY logical_session_id,content_epoch,coalesce(native_item_id,event_id))`;

      // Normalize actual JSON NUL escapes for search reads only. Preserve literal
      // backslash-u sequences; PostgreSQL otherwise rejects old binary tool output.
      const pgBody=String.raw`(CASE WHEN instr(b.body_json,'\u0000')>0 THEN regexp_replace(b.body_json,'(?<!\\)((?:\\\\)*)\\u0000','\1�','g') ELSE b.body_json END)::json`;
      const itemType=this.db.backend==='postgresql'?`json_extract_path_text(${pgBody},'item','type')`:SQLITE_ITEM_TYPE;
      const rows=await read<Row>(`SELECT s.logical_session_id AS "id",s.title,s.machine_id AS "machineId",coalesce(nullif(m.display_alias,''),m.name) AS "machineName",m.name AS hostname,s.project_id AS "projectId",p.alias AS project,coalesce(s.session_cwd,p.canonical_root) AS path,p.provider,s.managed,s.updated_at AS "updatedAt",s.execution_state AS state,CASE WHEN m.reachability='online' THEN 1 ELSE 0 END AS online,p.sync_content AS "syncContent" ${FROM} WHERE ${where}`,values);
      const scores=new Map(rows.map(row=>[row.id,metadataScore(row,query,terms)]));
      const hits=new Map<string,Hit>();
      let contentStatus:'searched'|'short_query'|'not_requested'|'unavailable'=query.length>=2?'searched':query?'short_query':'not_requested';
      if(contentStatus==='searched'&&rows.length){
        // Raw JSON is only a cheap candidate prefilter; final matching uses text blocks
        // exclusively, never attachment URLs, tool arguments, reasoning, or JSON keys.
        const encodedTerms=terms.map(term=>[...new Set([term,JSON.stringify(term).slice(1,-1)])]);
        const raw=encodedTerms.map(forms=>`(${forms.map(()=> 'instr(lower(b.body_json),?)>0').join(' OR ')} OR instr(${LOCATION},?)>0)`).join(' AND ');
        const rawValues=encodedTerms.flatMap((forms,index)=>[...forms,terms[index]!]);
        const anyRaw=[...new Set(encodedTerms.flat())];
        const text=this.db.backend==='postgresql'
          ? `CASE WHEN ${itemType}='agentMessage' THEN coalesce(json_extract_path_text(${pgBody},'item','text'),'') ELSE coalesce((SELECT string_agg(json_extract_path_text(block,'text'),chr(10)) FROM json_array_elements(CASE WHEN json_typeof(json_extract_path(${pgBody},'item','content'))='array' THEN json_extract_path(${pgBody},'item','content') ELSE '[]'::json END) block WHERE json_extract_path_text(block,'type')='text'),'') END`
          : `CASE WHEN ${itemType}='agentMessage' THEN coalesce(json_extract(b.body_json,'$.item.text'),'') ELSE coalesce((SELECT group_concat(json_extract(block.value,'$.text'),char(10)) FROM json_each(b.body_json,'$.item.content') block WHERE json_extract(block.value,'$.type')='text'),'') END`;
        const sql=`${latest()}, raw_candidates AS MATERIALIZED (SELECT s.logical_session_id AS id,e.event_id AS "eventId",e.content_epoch,coalesce(e.native_item_id,e.event_id) AS item_id,e.session_seq,${LOCATION} AS location,b.body_json
          ${FROM} JOIN durable_events e ON e.logical_session_id=s.logical_session_id JOIN content_blobs b ON b.payload_ref=e.payload_ref
          WHERE ${where} AND ${BASE_CONTENT} AND (${raw}) AND (${anyRaw.map(()=> 'instr(lower(b.body_json),?)>0').join(' OR ')})),
          candidates AS MATERIALIZED (SELECT id,"eventId",content_epoch,item_id,session_seq,${itemType} AS role,location,${text} AS text FROM raw_candidates b WHERE ${itemType} IN ('userMessage','agentMessage')),
          matches AS (SELECT id,"eventId",role,text,row_number() OVER(PARTITION BY id ORDER BY session_seq DESC) AS position FROM candidates WHERE EXISTS(SELECT 1 FROM latest l WHERE l.logical_session_id=candidates.id AND l.content_epoch=candidates.content_epoch AND l.item_id=candidates.item_id AND l.seq=candidates.session_seq) AND ${terms.map(()=>'(instr(lower(text),?)>0 OR instr(location,?)>0)').join(' AND ')} AND (${terms.map(()=> 'instr(lower(text),?)>0').join(' OR ')}))
          SELECT id,"eventId",role,${this.db.backend==='sqlite'?'json_quote(text) AS "quotedText"':'text'} FROM matches WHERE position=1`;
        try{for(const hit of await read<Hit>(sql,[principal.workspaceId,...values,now,...rawValues,...anyRaw,...terms.flatMap(term=>[term,term]),...terms]))hits.set(hit.id,{...hit,text:hit.quotedText===undefined?hit.text:JSON.parse(hit.quotedText) as string});}
        catch {signal?.throwIfAborted();contentStatus='unavailable';}
      }
      const sorted=rows.filter(row=>scores.get(row.id)!>0||hits.has(row.id)).sort((a,b)=>
        Math.max(scores.get(b.id)!,hits.has(b.id)?65:0)-Math.max(scores.get(a.id)!,hits.has(a.id)?65:0)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      const page=sorted.slice(offset,offset+limit);
      // Availability is checked against current policy, not inferred from managed=true.
      const available=new Set<string>(),visible=new Set<string>(),validHits=new Set<string>();
      if(page.length){
        const ids=page.map(row=>row.id);
        const currentTime=new Date().toISOString();
        for(const row of await read<{id:string;available:number}>(`${latest(ids)} SELECT s.logical_session_id AS id,CASE WHEN EXISTS(SELECT 1 FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref WHERE e.logical_session_id=s.logical_session_id AND ${CONTENT} AND ${itemType} IN ('userMessage','agentMessage')) THEN 1 ELSE 0 END AS available ${FROM} WHERE ${where} AND s.logical_session_id IN (${ids.map(()=>'?').join(',')})`,[principal.workspaceId,...ids,currentTime,...values,...ids])){visible.add(row.id);if(row.available)available.add(row.id);}
        const eventIds=ids.flatMap(id=>hits.has(id)?[hits.get(id)!.eventId]:[]);
        if(eventIds.length)for(const row of await read<{id:string}>(`${latest(ids)} SELECT e.event_id AS id ${FROM} JOIN durable_events e ON e.logical_session_id=s.logical_session_id JOIN content_blobs b ON b.payload_ref=e.payload_ref WHERE ${where} AND ${CONTENT} AND e.event_id IN (${eventIds.map(()=>'?').join(',')})`,[principal.workspaceId,...ids,...values,currentTime,...eventIds]))validHits.add(row.id);
      }
      // Revalidate exact source events after asynchronous reads, including deletion,
      // content epoch changes, expiry, disabled synchronization and retired hosts.
      const items=page.filter(row=>visible.has(row.id)&&(scores.get(row.id)!>0||validHits.has(hits.get(row.id)?.eventId??''))).map(row=>{
        const candidate=hits.get(row.id),hit=candidate&&validHits.has(candidate.eventId)?candidate:undefined,score=scores.get(row.id)!;
        return {...row,managed:Number(row.managed)===1,online:Number(row.online)===1,syncContent:undefined,
          contentAvailable:available.has(row.id),match:hit?'message':score>=100?'title':score===35?'approximate':'location',
          snippet:hit?searchSnippet(hit.text,terms):'',messageRole:hit?.role==='userMessage'?'user':hit?'assistant':null};
      });
      return {items,total:sorted.length,nextOffset:offset+limit<sorted.length?offset+limit:null,query,terms,mode:'keyword_fuzzy' as const,contentStatus};
    }finally{this.active--;}
  }
}
