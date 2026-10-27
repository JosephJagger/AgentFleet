import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ControlPlaneDatabase } from './database-fixture.js';
import { loadConfig } from '../src/config.js';
import { AuthService } from '../src/auth.js';
import { RegistryService } from '../src/registry.js';
import { SessionSearchService, metadataScore, searchTerms, searchSnippet } from '../src/session-search.js';

function fixture() {
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'search@example.test',ADMIN_PASSWORD:'fixture-password',PUBLIC_ORIGIN:'http://fixture.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const db=new ControlPlaneDatabase(':memory:');const {workspaceId}=db.bootstrap(config);
  const principal=new AuthService(db,config).servicePrincipal('search-fixture');const registry=new RegistryService(db,config);
  const at=new Date().toISOString();
  for(const [id,name,provider,online] of [['m1','CVN-78','codex','online'],['m2','B2A','claude','offline'],['m3','B52H','grok','online']]){
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES(?,?,?,?,?,'linux','24','x64','0.30.150',?,'compatible','["turn.start"]',?,?,?)`,id!,workspaceId,id!,id!,name!,online!,at,at,at);
    db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,provider,created_at,last_reported_at) VALUES(?,?,?,?,'HeraLens','/opt/HeraLens',?,?,?,?)`,id!,workspaceId,id!,id!,id!,provider!,at,at);
  }
  db.run('UPDATE machines SET discovery_json=?',JSON.stringify({agentRuntimes:{claude:{installed:true},grok:{installed:true,state:'ready',version:'fixture',checkedAt:at,capabilities:{create:true}}}}));
  const pgFile=process.env.AGENTFLEET_TEST_PG_CONFIG;
  const service=new SessionSearchService(db,pgFile?{url:JSON.parse(readFileSync(pgFile,'utf8')).url,schema:db.get<{name:string}>('SELECT current_schema() AS name')!.name}:undefined);
  const session=(machine:string,title:string)=>{db.run("UPDATE machines SET reachability='online' WHERE machine_id=?",machine);const s=registry.createSession(principal,machine,machine,title);if(machine==='m2')db.run("UPDATE machines SET reachability='offline' WHERE machine_id=?",machine);return s;};
  let seq=0;
  const event=(s:ReturnType<typeof session>,item:Record<string,unknown>)=>{
    const n=++seq,id=`event-${n}`,ref=`blob-${n}`;
    db.run('INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)',ref,workspaceId,JSON.stringify({item}),'hash',at,'9999-12-31T00:00:00Z');
    db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,native_item_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state) VALUES(?,'hash','agent',?,?,?,?,?,?,1,'native','turn',?,'item.completed','1',?,?,?,'present')`,id,workspaceId,s.logicalSessionId,s.executionSegmentId,s.machineId,s.projectId,n,String(item.id??id),at,at,ref);
    return {id,ref};
  };
  const ask=(s:ReturnType<typeof session>,text:string)=>event(s,{type:'userMessage',content:[{type:'text',text}]});
  const find=(q:string,filters:Record<string,unknown>={})=>service.search(principal,{q,...filters});
  return {db,config,service,principal,workspaceId,session,event,ask,find,close:async()=>{await service.close();db.close();}};
}

test('global matches include offline hosts and all providers, ranking exact titles before messages and fuzzy titles',async t=>{
  const f=fixture();t.after(f.close);
  const title=f.session('m1','SSH 配置'),context=f.session('m2','插件开发'),grok=f.session('m3','视频生成');
  f.ask(context,'之前的 SSH 配置可以跨主机复用吗');f.ask(grok,'生成一段视频');
  const result=await f.find('SSH 配置');
  assert.deepEqual(result.items.map(item=>item.id),[title.logicalSessionId,context.logicalSessionId]);
  assert.equal(result.items[1]!.online,false);assert.equal(result.items[1]!.provider,'claude');assert.equal(result.items[1]!.match,'message');assert.match(result.items[1]!.snippet,/SSH 配置/);
  assert.equal((await f.find('B2A SSH')).items[0]!.id,context.logicalSessionId);
  assert.equal((await f.find('视频')).items[0]!.provider,'grok');
  assert.equal((await f.find('SSH',{machineId:'m1'})).items.length,1);
  assert.equal((await f.find('SSH',{provider:'grok'})).items.length,0);
  const fuzzy=f.session('m1','Deployment troubleshooting');assert.equal((await f.find('deploymnt')).items[0]!.id,fuzzy.logicalSessionId);
  assert.equal((await f.service.search({...f.principal,workspaceId:'another'}, {q:'SSH'})).items.length,0);
});

test('message search only reads dialogue text, including all text blocks and old message tails',async t=>{
  const f=fixture();t.after(f.close);const s=f.session('m1','任务');
  f.event(s,{type:'commandExecution',aggregatedOutput:'secret-tool-output\u0000binary',command:'secret-command'});
  f.event(s,{type:'reasoning',text:'secret-reasoning'});
  f.event(s,{type:'userMessage',content:[{type:'image',url:'https://secret-attachment.invalid'},{type:'text',text:'第一段'},{type:'text',text:'第二段最末尾的线索'}]});
  f.event(s,{type:'agentMessage',text:'start '.repeat(4000)+'长回复最后的证据'});
  for(const q of ['secret-tool-output','secret-command','secret-reasoning','secret-attachment','userMessage'])assert.equal((await f.find(q)).items.length,0,q);
  assert.match((await f.find('第一段 线索')).items[0]!.snippet,/第二段/);
  f.ask(s,String.raw`路径 C:\work\demo 与 \"quoted\" 内容`);
  assert.equal((await f.find(String.raw`C:\work\demo`)).items.length,1);
  f.ask(s,'zero\u0000byte control');f.ask(s,String.raw`literal \u0000 preserved`);
  assert.match((await f.find('byte control')).items[0]!.snippet,/byte control/);
  assert.match((await f.find('literal')).items[0]!.snippet,/\\u0000/);
  const tail=(await f.find('最后的证据')).items[0]!;assert.match(tail.snippet,/最后的证据/);assert.ok(tail.snippet.length<=242);
});

test('content availability comes from actual retained data, not managed state',async t=>{
  const f=fixture();t.after(f.close);const empty=f.session('m1','Empty managed'),native=f.session('m2','Native synced');
  f.db.run('UPDATE logical_sessions SET managed=0 WHERE logical_session_id=?',native.logicalSessionId);f.ask(native,'已同步的线索');
  assert.equal((await f.find('Empty')).items[0]!.contentAvailable,false);
  assert.equal((await f.find('线索')).items[0]!.contentAvailable,true);assert.equal((await f.find('线索')).items[0]!.managed,false);
  assert.equal((await f.find('线索',{managed:'true'})).items.length,0);
  f.db.run('UPDATE projects SET sync_content=0 WHERE project_id=?',native.projectId);
  assert.equal((await f.find('线索')).items.length,0);assert.equal((await f.find('Native')).items[0]!.contentAvailable,false);
  assert.equal((await f.find('E')).contentStatus,'short_query');assert.ok(empty.logicalSessionId);
});

test('deleted, expired, suppressed, old-epoch, tombstoned and superseded messages never match',async t=>{
  const f=fixture();t.after(f.close);
  for(const kind of ['expired','deleted','suppressed','epoch','tombstone','superseded']){
    const s=f.session('m1',kind),event=f.event(s,{id:'message',type:'agentMessage',text:'hiddenneedle'});
    if(kind==='expired')f.db.run("UPDATE content_blobs SET expires_at='2000-01-01' WHERE payload_ref=?",event.ref);
    if(kind==='deleted')f.db.run("UPDATE content_blobs SET deleted_at='2000-01-01' WHERE payload_ref=?",event.ref);
    if(kind==='suppressed')f.db.run("UPDATE durable_events SET payload_state='suppressed' WHERE event_id=?",event.id);
    if(kind==='epoch')f.db.run('UPDATE logical_sessions SET content_epoch=2 WHERE logical_session_id=?',s.logicalSessionId);
    if(kind==='tombstone')f.db.run("INSERT INTO content_tombstones VALUES(?,?,?,'hash',1,2,'user_deleted',?)",event.id,f.workspaceId,s.logicalSessionId,new Date().toISOString());
    if(kind==='superseded')f.event(s,{id:'message',type:'agentMessage',text:'replacement'});
  }
  assert.equal((await f.find('hiddenneedle')).items.length,0);
  const removed=f.session('m2','Removed'),ev=f.ask(removed,'retired-host-needle');
  f.db.run("UPDATE machines SET identity_state='revoked' WHERE machine_id='m2'");assert.equal((await f.find('retired-host-needle')).items.length,0);
  f.db.run("UPDATE logical_sessions SET deleted_at=? WHERE logical_session_id=?",new Date().toISOString(),removed.logicalSessionId);assert.equal((await f.find('Removed')).items.length,0);assert.ok(ev.id);
});

test('pagination searches beyond dashboard windows, filters and literal punctuation are safe',async t=>{
  const f=fixture();t.after(f.close);
  for(let n=0;n<45;n++)f.session('m1',`批量任务 ${n}`);
  let offset=0;const ids=new Set<string>();
  while(true){const result=await f.find('批量任务',{offset,limit:20});assert.equal(result.total,45);for(const item of result.items){assert.ok(!ids.has(item.id));ids.add(item.id);}if(result.nextOffset===null)break;offset=result.nextOffset;}
  assert.equal(ids.size,45);
  const literal=f.session('m1','100% _done');f.ask(literal,'literal % and _ are searchable');
  assert.equal((await f.find('100%')).items.length,1);assert.equal((await f.find("' OR 1=1 --")).items.length,0);
  for(const input of [{q:'x'.repeat(161)},{q:'a b c d e f g h i'},{offset:-1},{limit:999},{managed:'false'},{q:['x']}])await assert.rejects(f.service.search(f.principal,input),{code:'SEARCH_INPUT'});
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')!.n,0);
});

test('matching helpers distinguish approximations and return the actual matching excerpt',()=>{
  const row={title:'Grok 视频生成与存储',machineName:'Host',hostname:'srv1',project:'Demo',path:'/root/demo',provider:'grok'};
  assert.equal(metadataScore(row,'视频存储',searchTerms('视频存储')),35);
  assert.equal(metadataScore(row,'完全无关',searchTerms('完全无关')),0);
  assert.equal(searchSnippet('a'.repeat(600)+'target', ['target']).endsWith('target'),true);
});

test('rechecks the exact message when content is removed during an asynchronous query',async t=>{
  const f=fixture();t.after(f.close);const s=f.session('m1','Unrelated title'),hidden=f.ask(s,'disappearingneedle');f.ask(s,'Another retained message');
  const internals=f.service as unknown as {read:(sql:string,values:unknown[])=>Promise<object[]>};const original=internals.read;
  t.mock.method(internals,'read',async(sql:string,values:unknown[])=>{const result=await original(sql,values);if(sql.includes('candidates AS'))f.db.run("UPDATE content_blobs SET deleted_at=? WHERE payload_ref=?",new Date().toISOString(),hidden.ref);return result;});
  const result=await f.find('disappearingneedle');assert.equal(result.items.length,0);
});

test('abandoned searches skip the expensive content read and release admission slots',async t=>{
  const f=fixture();t.after(f.close);f.session('m1','Task');
  const controller=new AbortController();
  const internals=f.service as unknown as {read:(sql:string,values:unknown[])=>Promise<object[]>};const original=internals.read;let calls=0;
  const mock=t.mock.method(internals,'read',async(sql:string,values:unknown[])=>{calls++;const result=await original(sql,values);controller.abort();return result;});
  await assert.rejects(f.service.search(f.principal,{q:'needle'},controller.signal),{name:'AbortError'});assert.equal(calls,1);
  mock.mock.restore();assert.equal((await f.find('Task')).items.length,1);
});
