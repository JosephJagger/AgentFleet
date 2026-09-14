import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { WritingMemory, extractWritingCandidates, safeWritingText } from "../src/writing-memory.js";
import { WritingAI, relevantWritingVocabulary } from "../src/writing-ai.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";

const config = () => ({ ...loadConfig({ ADMIN_EMAIL:"writing@example.test", ADMIN_PASSWORD:"writing-test-password", PUBLIC_ORIGIN:"http://writing.test", COOKIE_SECURE:"false", LOG_LEVEL:"silent" }), databasePath: ":memory:" });
function fixture() {
  const db = new ControlPlaneDatabase(":memory:"); const { workspaceId,userId } = db.bootstrap(config()); const at = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at) VALUES('m',?,'key','fingerprint','host','linux','24','x64',?,?)`,workspaceId,at,at);
  for (const id of ["a","b"]) {
    db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES(?,?,'m',?,?,?,?,?,?)`,id,workspaceId,id,id,`/work/${id}`,id,at,at);
    db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'m',?,?,1,'idle','live',?,?)`,id,workspaceId,id,id,at,at);
    db.run(`INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,created_at) VALUES(?,?,'m',?,?)`,id,id,id,at);
  }
  const principal = {workspaceId,userId,clientSessionId:"test",email:"writing@example.test",csrfHash:"",expiresAt:at};
  const service = new WritingMemory(db);
  function event(seq:number, text:string, type="agentMessage") {
    const id = `event-${seq}`;
    db.run("INSERT INTO content_blobs(payload_ref,workspace_id,body_json,payload_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)",id,workspaceId,JSON.stringify({item:{type,text,content:[{text}]}}),id,at,"2099-01-01T00:00:00Z");
    db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,type,schema_version,occurred_at,received_at,payload_ref,payload_state) VALUES(?,?,'agent',?,'a','a','m','a',?,1,'item.completed','1.0',?,?,?,'present')`,id,id,workspaceId,seq,at,at,id);
    db.run("UPDATE logical_sessions SET next_session_seq=? WHERE logical_session_id='a'",seq+1);
    service.learnEvent(id);
    return id;
  }
  return {db,principal,service,event};
}

test("extracts bilingual definitions and marked terms, skips secrets and code",()=>{
  assert.deepEqual(extractWritingCandidates('“等我输完再查”称为“防抖”'),[{phrase:"等我输完再查",replacement:"防抖"}]);
  assert.deepEqual(extractWritingCandidates('"wait until typing stops" means "debounce"'),[{phrase:"wait until typing stops",replacement:"debounce"}]);
  assert.deepEqual(extractWritingCandidates('Use `ProjectWidget`.\npassword=secret `DoNotLearn`\n```\n`IgnoreMe`\n```'),[{phrase:"ProjectWidget",replacement:"ProjectWidget"}]);
  assert.equal(safeWritingText("Bearer abcdefgh"),false);
});

test("default learning activates filtered entries, deduplicates, honors opt out and never relearns deleted terms",t=>{
  const {db,principal,service,event}=fixture();t.after(()=>db.close());
  assert.equal(service.read(principal,"a").enabled,true);
  const id=event(1,"Use `ProjectWidget`");service.learnEvent(id);
  assert.equal(service.read(principal,"a").entries.length,1);
  const entry=service.read(principal,"a").entries[0]!;assert.equal(entry.status,"active");assert.equal(entry.source_event,id);
  service.save(principal,"a",entry,entry.id);assert.equal(service.read(principal,"a").entries[0]!.status,"active");
  service.remove(principal,"a",entry.id);event(2,"Use `ProjectWidget`");assert.equal(service.read(principal,"a").entries.length,0);
  assert.equal(db.get<{phrase:string}>("SELECT phrase FROM writing_memory WHERE id=?",entry.id)!.phrase,"");
  service.configure(principal,"a",{enabled:false,scope:"project"});event(3,"Use `AnotherWidget`");assert.equal(service.read(principal,"a").entries.length,0);
  service.configure(principal,"a",{enabled:true,scope:"project"});service.learnEvent("event-3");assert.equal(service.read(principal,"a").entries.length,0);
  event(4,"Use `NewWidget`");assert.equal(service.read(principal,"a").entries.length,1);
  event(5,"Use `SecretReasoning`","reasoning");assert.equal(service.read(principal,"a").entries.length,1);
});

test("scopes entries to account and project, supports editing and accepted-use ranking",t=>{
  const {db,principal,service}=fixture();t.after(()=>db.close());
  service.save(principal,"a",{phrase:"wait for input",replacement:"debounce",scope:"project"});
  assert.equal(service.read(principal,"b").entries.length,0);
  const entry=service.read(principal,"a").entries[0]!;
  assert.throws(()=>service.remove(principal,"b",entry.id));
  assert.equal(service.read({...principal,userId:"someone-else"},"a").entries.length,0);
  assert.throws(()=>service.read({...principal,workspaceId:"elsewhere"},"a"));
  service.save(principal,"a",{...entry,scope:"personal"},entry.id);
  service.feedback(principal,"b",entry.id);assert.equal(service.read(principal,"b").entries[0]!.uses,1);
  assert.throws(()=>service.save(principal,"a",{phrase:"password=secret",replacement:"invalid",scope:"personal"}));
});

test("AI is optional, encrypts credentials, never returns them, and clears credentials on provider changes",async t=>{
  const {db,principal,service}=fixture();t.after(()=>db.close());
  let calls=0;
  const ai=new WritingAI(db,":memory:",service,(async(url,options)=>{
    calls++;assert.equal(url,"https://provider.test/v1/chat/completions");
    assert.equal(new Headers(options?.headers).get("Authorization"),"Bearer test-key");
    const body=JSON.parse(String(options?.body));assert.equal(body.model,"test-model");assert.equal(body.messages.length,2);
    return Response.json({choices:[{message:{content:JSON.stringify({suggestions:["Investigate page loading performance"]})}}]});
  }) as typeof fetch);
  assert.equal(ai.read(principal).configured,false);
  await assert.rejects(()=>ai.suggest(principal,"a","page is slow"));assert.equal(calls,0);
  ai.save(principal,{endpoint:"https://provider.test/v1",model:"test-model",apiKey:"test-key",enabled:true});
  assert.ok(!JSON.stringify(ai.read(principal)).includes("test-key"));assert.ok(!JSON.stringify(db.all("SELECT * FROM writing_ai")).includes("test-key"));
  assert.deepEqual((await ai.suggest(principal,"a","page is slow")).suggestions,["Investigate page loading performance"]);
  ai.save(principal,{endpoint:"https://other.test/v1",model:"test-model",enabled:true});assert.equal(ai.read(principal).hasKey,false);
  assert.throws(()=>ai.save(principal,{endpoint:"http://public.test/v1",model:"test",enabled:true}));
});

test("writing routes require authentication, CSRF, and do not call AI when unconfigured",async t=>{
  const {app,db}=await buildControlPlane(config());t.after(()=>app.close());
  assert.equal((await app.inject({method:"GET",url:"/api/settings/writing-ai"})).statusCode,401);
  assert.equal((await app.inject({method:"GET",url:"/api/sessions/a/writing-memory"})).statusCode,401);
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"http://writing.test"},payload:{email:"writing@example.test",password:"writing-test-password"}});
  const cookie=cookieFromSetCookie(login.headers["set-cookie"]);
  const read=await app.inject({method:"GET",url:"/api/settings/writing-ai",headers:{cookie}});assert.equal(read.statusCode,200);assert.equal(read.json().configured,false);
  const save={endpoint:"https://provider.test/v1",model:"test-model",enabled:false};
  assert.equal((await app.inject({method:"PUT",url:"/api/settings/writing-ai",headers:{cookie},payload:save})).statusCode,403);
  assert.equal((await app.inject({method:"PUT",url:"/api/settings/writing-ai",headers:{...csrfHeaders(login.json().csrfToken,"http://writing.test"),cookie},payload:save})).statusCode,200);
  assert.equal((await app.inject({method:"GET",url:"/api/sessions/nlp-session/writing-history"})).statusCode,401);
  assert.equal((await app.inject({method:"PUT",url:"/api/sessions/nlp-session/writing-history/event",headers:{cookie},payload:{rating:"useful"}})).statusCode,403);
  const url="/api/sessions/nlp-session/writing-nlp";
  const payload={draft:"登录之后过一会儿就自己退出来了"};
  assert.equal((await app.inject({method:"POST",url,payload})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url,headers:{cookie},payload})).statusCode,403);
  const headers={...csrfHeaders(login.json().csrfToken,"http://writing.test"),cookie};
  assert.equal((await app.inject({method:"POST",url,headers,payload})).statusCode,404);
  const {workspaceId}=db.bootstrap(config());const at=new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at) VALUES('nlp-m',?,'key','nlp-key','host','linux','24','x64',?,?)`,workspaceId,at,at);
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('nlp-p',?,'nlp-m','p','p','/nlp','nlp',?,?)`,workspaceId,at,at);
  db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES('nlp-session',?,'nlp-m','nlp-p','session',1,'idle','live',?,?)`,workspaceId,at,at);
  const result=await app.inject({method:"POST",url,headers,payload});
  assert.equal(result.statusCode,200);assert.equal(result.json().suggestions[0].intent,"session-expiry");
  assert.equal(result.headers["cache-control"],"no-store");
  assert.equal(db.get<{n:number}>("SELECT COUNT(*) n FROM writing_memory")!.n,0);
  assert.equal(db.get<{n:number}>("SELECT COUNT(*) n FROM content_blobs")!.n,0);
  for(let i=0;i<89;i++) await app.inject({method:"POST",url,headers,payload});
  assert.equal((await app.inject({method:"POST",url,headers,payload})).statusCode,429);
});

test("history pairs only matching native turns, records personal feedback, and honors source retention",async t=>{
  const {WritingHistory}=await import("../src/writing-history.js");
  const {db,principal,service,event}=fixture();t.after(()=>db.close());
  const history=new WritingHistory(db,service);
  event(1,"登录后又让我输入密码","userMessage");event(2,"需要检查会话状态");event(3,"另一轮的回答");event(4,"终止标记");
  db.run("UPDATE durable_events SET native_thread_id='thread',native_turn_id='turn-1' WHERE event_id IN ('event-1','event-2','event-4')");
  db.run("UPDATE durable_events SET native_thread_id='thread',native_turn_id='turn-2' WHERE event_id='event-3'");
  db.run("UPDATE durable_events SET type='turn.failed' WHERE event_id='event-4'");
  const first=history.read(principal,"a");
  assert.equal(first.interactions.length,2);
  const paired=first.interactions.find(item=>item.paired)!;
  assert.equal(paired.state,"failed");assert.deepEqual(paired.messages.map(item=>item.role),["user","assistant"]);
  assert.deepEqual(paired.messages.map(item=>item.eventId),["event-1","event-2"]);
  history.feedback(principal,"a",paired.id,"useful");
  assert.equal(history.read(principal,"a").interactions.find(item=>item.paired)!.feedback,"useful");
  assert.equal(history.read({...principal,userId:"another-user"},"a").interactions.find(item=>item.paired)!.feedback,null);
  assert.equal(history.read(principal,"b").interactions.length,0);
  assert.throws(()=>history.feedback(principal,"b",paired.id,"useful"));
  assert.throws(()=>history.feedback(principal,"a","event-3","useful"));
  assert.throws(()=>history.read({...principal,workspaceId:"another-workspace"},"a"));
  history.feedback(principal,"a",paired.id,"clear");assert.equal(db.all("SELECT * FROM writing_history_feedback").length,0);
  db.run("UPDATE content_blobs SET expires_at='2000-01-01' WHERE payload_ref='event-1'");
  assert.ok(history.read(principal,"a").interactions.every(item=>!item.paired));
  assert.ok(!JSON.stringify(history.read(principal,"a")).includes("登录后又让我输入密码"));
  db.run("UPDATE projects SET sync_content=0 WHERE project_id='a'");assert.equal(history.read(principal,"a").interactions.length,0);
});

test("unknown turn IDs stay unpaired and extracted terms show the source role without promoting assistant claims",async t=>{
  const {WritingHistory}=await import("../src/writing-history.js");
  const {db,principal,service,event}=fixture();t.after(()=>db.close());
  event(1,'"slow input" means "debounce"',"userMessage");event(2,"Use `LocalWidget`");
  const entries=service.read(principal,"a").entries;
  assert.equal(entries.find(item=>item.phrase==="slow input")!.source_role,"user");
  assert.equal(entries.find(item=>item.phrase==="LocalWidget")!.source_role,"assistant");
  assert.ok(entries.every(item=>item.status==="active"));
  const history=new WritingHistory(db,service);
  assert.ok(history.read(principal,"a").interactions.every(item=>!item.paired));
  db.run("UPDATE content_blobs SET deleted_at=? WHERE payload_ref='event-2'",new Date().toISOString());
  assert.equal(service.read(principal,"a").entries.length,1);
  assert.equal(db.get("SELECT phrase FROM writing_memory WHERE fingerprint=?", (await import('../src/crypto.js')).sha256('localwidget')),undefined);
});


test("writing defaults inherit per option across sessions, isolate accounts, and can be restored",async t=>{
 const {WritingPreferences}=await import('../src/writing-preferences.js');
 const {db,principal}=fixture();t.after(()=>db.close());const prefs=new WritingPreferences(db);
 assert.deepEqual(prefs.read(principal,'a').effective,{terms:true,suggestions:true,nlp:true,learning:true});
 prefs.save(principal,{settings:{terms:false,learning:false}});
 assert.equal(prefs.read(principal,'a').effective.terms,false);assert.equal(prefs.read(principal,'b').effective.learning,false);
 prefs.save(principal,{settings:{terms:true}},'a');
 prefs.save(principal,{settings:{nlp:false}});
 assert.equal(prefs.read(principal,'a').effective.terms,true);assert.equal(prefs.read(principal,'a').effective.nlp,false);
 assert.equal(prefs.read({...principal,userId:'other'},'a').effective.terms,true);
 prefs.save(principal,{settings:null},'a');assert.equal(prefs.read(principal,'a').effective.terms,false);
 assert.throws(()=>prefs.save(principal,{settings:{learning:'yes'}}));
 assert.throws(()=>prefs.read({...principal,workspaceId:'elsewhere'},'a'));
});

test("global learning opt out skips events and session override resumes without replay",async t=>{
 const {WritingPreferences}=await import('../src/writing-preferences.js');
 const {db,principal,service,event}=fixture();t.after(()=>db.close());const prefs=new WritingPreferences(db);
 prefs.save(principal,{settings:{learning:false}});event(1,'Use `SkippedTerm`');
 assert.equal(service.read(principal,'a').entries.length,0);
 prefs.save(principal,{settings:{learning:true}},'a');service.learnEvent('event-1');
 assert.equal(service.read(principal,'a').entries.length,0);
 event(2,'Use `AutomaticTerm`');assert.equal(service.read(principal,'a').entries[0]!.status,'active');
});

test("explicit answer rewrites automatically become scoped suggestions only for the linked question",t=>{
 const {db,principal,service,event}=fixture();t.after(()=>db.close());
 event(1,'点两下就出现两条订单','userMessage');
 db.run("UPDATE durable_events SET native_thread_id='thread',native_turn_id='turn' WHERE event_id='event-1'");
 event(2,'可以表述为“排查订单重复创建并检查幂等性”');
 db.run("UPDATE durable_events SET native_thread_id='thread',native_turn_id='turn' WHERE event_id='event-2'");
 // Build the native event metadata before the one successful learning pass.
 db.run("DELETE FROM writing_learning");service.learnEvent('event-2');
 const entries=service.read(principal,'a').entries;
 assert.equal(entries.length,1);assert.equal(entries[0]!.phrase,'点两下就出现两条订单');
 assert.equal(entries[0]!.status,'active');assert.ok(entries[0]!.replacement.endsWith('点两下就出现两条订单'));
 assert.equal(service.read(principal,'b').entries.length,0);
 db.run("UPDATE content_blobs SET deleted_at='2026-01-01' WHERE payload_ref='event-1'");service.cleanup();
 assert.equal(service.read(principal,'a').entries.length,0);
});

test("DeepSeek optimization disables thinking and reports safe actionable failures", async t => {
  const {db,principal,service}=fixture();t.after(()=>db.close());
  let response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({suggestions:['排查登录会话意外失效的原因']})}}]});
  let timeout=false;
  const ai=new WritingAI(db,':memory:',service,async(url,options)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(String(options?.body));
    assert.deepEqual(body.thinking,{type:'disabled'});assert.ok(body.max_tokens>=2000);
    if(timeout)throw new DOMException('private provider details','TimeoutError');
    return response();
  });
  ai.save(principal,{endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'test-key',enabled:true});
  assert.equal((await ai.suggest(principal,'a','登录老掉')).suggestions.length,1);
  for(const [status,code] of [[401,'WRITING_AI_AUTH'],[402,'WRITING_AI_BALANCE'],[429,'WRITING_AI_RATE_LIMIT'],[400,'WRITING_AI_CONFIG'],[503,'WRITING_AI_FAILED']] as const){
    ai.save(principal,{endpoint:'https://api.deepseek.com',model:'deepseek-flash',enabled:true});
    response=()=>Response.json({error:{message:'private provider details'}},{status});
    await assert.rejects(()=>ai.suggest(principal,'a','登录老掉'),(e:any)=>e.code===code && !e.message.includes('private'));
  }
  response=()=>Response.json({choices:[{finish_reason:'length',message:{content:'{"suggestions":['}}]});
  await assert.rejects(()=>ai.suggest(principal,'a','登录老掉'),{code:'WRITING_AI_TRUNCATED'});
  response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:'invalid JSON'}}]});
  await assert.rejects(()=>ai.suggest(principal,'a','登录老掉'),{code:'WRITING_AI_FORMAT'});
  timeout=true;await assert.rejects(()=>ai.suggest(principal,'a','登录老掉'),{code:'WRITING_AI_TIMEOUT'});
});

test("OpenAI uses its token parameter while custom providers retain compatible parameters",async t=>{
 const {db,principal,service}=fixture();t.after(()=>db.close());
 let expected='api.openai.com';
 const ai=new WritingAI(db,':memory:',service,async(url,options)=>{
  const body=JSON.parse(String(options?.body));assert.equal(new URL(String(url)).hostname,expected);
  assert.equal(body.thinking,undefined);
  if(expected==='api.openai.com'){assert.equal(body.max_completion_tokens,2400);assert.equal(body.max_tokens,undefined);}
  else {assert.equal(body.max_tokens,2400);assert.equal(body.max_completion_tokens,undefined);}
  return Response.json({choices:[{message:{content:'{"suggestions":["Investigate login session expiry","Second alternative"]}'}}]});
 });
 for(const endpoint of ['https://api.openai.com/v1','https://api.deepseek.com.example.test/v1']){
  expected=new URL(endpoint).hostname;ai.save(principal,{endpoint,model:'gpt-4.1-mini',enabled:true});
  assert.deepEqual((await ai.suggest(principal,'a','login keeps dropping')).suggestions,['Investigate login session expiry']);
 }
});

test('AI cache merges concurrent requests, expires, isolates sessions and invalidates on vocabulary or configuration changes', async t => {
 const {db,principal,service}=fixture();t.after(()=>db.close());
 let calls=0,now=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const ai=new WritingAI(db,':memory:',service,async()=>{
  calls++;await gate;
  return Response.json({choices:[{message:{content:'{"suggestions":["Investigate login session expiry"]}'}}]});
 },()=>now);
 ai.save(principal,{endpoint:'https://provider.test/v1',model:'test',enabled:true});
 const first=ai.suggest(principal,'a','login keeps dropping');
 const second=ai.suggest(principal,'a','login keeps dropping');
 assert.equal(calls,1);release();
 const results=await Promise.all([first,second]);assert.deepEqual(results[0],results[1]);
 results[0].suggestions[0]='mutated';
 assert.equal((await ai.suggest(principal,'a','login keeps dropping')).suggestions[0],'Investigate login session expiry');assert.equal(calls,1);
 await assert.rejects(()=>ai.suggest({...principal,workspaceId:'other'},'a','login keeps dropping'));assert.equal(calls,1);
 await ai.suggest(principal,'b','login keeps dropping');assert.equal(calls,2);
 now=600001;await ai.suggest(principal,'a','login keeps dropping');assert.equal(calls,3);
 service.save(principal,'a',{phrase:'login',replacement:'登录会话',scope:'project'});
 await ai.suggest(principal,'a','login keeps dropping');assert.equal(calls,4);
 ai.save(principal,{endpoint:'https://provider.test/v1',model:'other-model',enabled:true});
 await ai.suggest(principal,'a','login keeps dropping');assert.equal(calls,5);
 ai.save(principal,{endpoint:'https://provider.test/v1',model:'other-model',enabled:false});
 await assert.rejects(()=>ai.suggest(principal,'a','login keeps dropping'),{code:'WRITING_AI_DISABLED'});assert.equal(calls,5);
});

test('AI failed requests are shared but not cached; unrelated vocabulary is omitted',async t=>{
 const {db,principal,service}=fixture();t.after(()=>db.close());
 service.save(principal,'a',{phrase:'rendering',replacement:'视频渲染',scope:'project'});
 let calls=0;
 const ai=new WritingAI(db,':memory:',service,async(_url,options)=>{
  calls++;const body=JSON.parse(String(options?.body));assert.equal(JSON.parse(body.messages[1].content).vocabulary,undefined);
  if(calls===1)throw new Error('temporary failure');
  return Response.json({choices:[{message:{content:'{"suggestions":[]}'}}]});
 });
 ai.save(principal,{endpoint:'https://provider.test/v1',model:'test',enabled:true});
 const results=await Promise.allSettled([ai.suggest(principal,'a','login drops'),ai.suggest(principal,'a','login drops')]);
 assert.ok(results.every(r=>r.status==='rejected'));assert.equal(calls,1);
 await ai.suggest(principal,'a','login drops');await ai.suggest(principal,'a','login drops');assert.equal(calls,2);
});

test('vocabulary retrieval matches Chinese and English terms, excludes unrelated terms and caps context at five',()=>{
 const entries=[{phrase:'登录会话',replacement:'用户身份验证会话',status:'active'},
 {phrase:'rendering',replacement:'视频渲染',status:'active'},
 ...Array.from({length:8},(_,i)=>({phrase:`session timeout ${i}`,replacement:'登录会话过期',status:'active'}))];
 assert.equal(relevantWritingVocabulary('登录会话经常失效',entries)[0]?.phrase,'登录会话');
 const english=relevantWritingVocabulary('Fix session timeout',entries);
 assert.equal(english.length,5);assert.ok(english.every(e=>e.phrase.startsWith('session timeout')));
 assert.deepEqual(relevantWritingVocabulary('make a spreadsheet',entries),[]);
});
