import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { WritingMemory, extractWritingCandidates, safeWritingText } from "../src/writing-memory.js";
import { WritingAI } from "../src/writing-ai.js";
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

test("default learning yields candidates, deduplicates, honors opt out and never relearns deleted terms",t=>{
  const {db,principal,service,event}=fixture();t.after(()=>db.close());
  assert.equal(service.read(principal,"a").enabled,true);
  const id=event(1,"Use `ProjectWidget`");service.learnEvent(id);
  assert.equal(service.read(principal,"a").entries.length,1);
  const entry=service.read(principal,"a").entries[0]!;assert.equal(entry.status,"candidate");assert.equal(entry.source_event,id);
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
  const {app}=await buildControlPlane(config());t.after(()=>app.close());
  assert.equal((await app.inject({method:"GET",url:"/api/settings/writing-ai"})).statusCode,401);
  assert.equal((await app.inject({method:"GET",url:"/api/sessions/a/writing-memory"})).statusCode,401);
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin:"http://writing.test"},payload:{email:"writing@example.test",password:"writing-test-password"}});
  const cookie=cookieFromSetCookie(login.headers["set-cookie"]);
  const read=await app.inject({method:"GET",url:"/api/settings/writing-ai",headers:{cookie}});assert.equal(read.statusCode,200);assert.equal(read.json().configured,false);
  const save={endpoint:"https://provider.test/v1",model:"test-model",enabled:false};
  assert.equal((await app.inject({method:"PUT",url:"/api/settings/writing-ai",headers:{cookie},payload:save})).statusCode,403);
  assert.equal((await app.inject({method:"PUT",url:"/api/settings/writing-ai",headers:{...csrfHeaders(login.json().csrfToken,"http://writing.test"),cookie},payload:save})).statusCode,200);
});
