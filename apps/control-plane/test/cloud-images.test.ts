import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth.js";
import { CoordinationService } from "../src/coordination.js";
import { readEventImage } from "../src/cloud-image-delivery.js";
import { parseImages } from "../src/images.js";
import { CloudImages, CLOUD_IMAGE_QUOTA } from "../src/cloud-images.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "./server-fixture.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDatabase } from "./database-fixture.js";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const second = "data:image/png;base64," + Buffer.concat([Buffer.from(png.split(",")[1]!, "base64"), Buffer.from([0])]).toString("base64");

async function fixture(t: import("node:test").TestContext, disk = false) {
  const origin = "http://images.test", password = "isolated-image-quota-password";
  const path = disk ? join(mkdtempSync(join(tmpdir(), "agentfleet-images-")), "db.sqlite") : ":memory:";
  const result = await buildControlPlane({ ...loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "images@example.test", ADMIN_PASSWORD: password, PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: path });
  t.after(() => result.app.close());
  const login = await result.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "images@example.test", password } });
  const headers = { cookie: cookieFromSetCookie(login.headers["set-cookie"]), ...csrfHeaders(login.json().csrfToken, origin) };
  const ws = result.db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces")!.workspace_id;
  for (const id of ["image-a", "image-b"]) result.db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES(?,?,?,?,?,'linux','fixture','x64',?,?)`, id, ws, id, id, id, new Date().toISOString(), new Date().toISOString());
  return { ...result, path, headers, store: new CloudImages(result.db) };
}

test("generated images retain original pixels above the input limit and use owner-bound storage and cleanup tombstones", async t => {
  const { db, store, app, headers } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from(png.split(",")[1]!, "base64"), Buffer.alloc(180_000)]);
  const generated = `data:image/png;base64,${bytes.toString("base64")}`;
  const body = { item: { type: "imageGeneration", id: "generated", status: "completed", content: [{ type: "image", url: generated }] } };
  const saved = db.transaction(() => store.store("image-a", "event", "generated-event", body, "sync"));
  assert.equal(JSON.stringify(saved).includes(generated), false);
  assert.deepEqual(store.hydrate("image-a", "event", "generated-event", saved), body);
  assert.equal(JSON.stringify(store.hydrate("image-b", "event", "generated-event", saved)).includes(generated), false);
  assert.equal(JSON.stringify(store.hydrate("image-a", "event", "other-event", saved)).includes(generated), false);
  assert.equal(store.stats("image-a").usedBytes, Buffer.byteLength(generated));
  const cleared = await app.inject({ method: "POST", url: "/api/machines/image-a/images/clear", headers, payload: { revision: store.stats("image-a").revision, confirmCloudOnly: true } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(JSON.stringify(store.hydrate("image-a", "event", "generated-event", saved)).includes(generated), false);
  const replay = db.transaction(() => store.store("image-a", "event", "generated-replay", body, "sync"));
  assert.equal(JSON.stringify(replay).includes(generated), false);
  assert.equal(store.stats("image-a").usedBytes, 0);
});

test("image quota is per machine, counts unique encoded bytes; clear needs confirmation and never restores replayed pixels", async t => {
  const { app, db, store, headers } = await fixture(t);
  const body = { item: { type: "userMessage", content: [{ type: "text", text: "keep this text" }, { type: "image", url: png }] } };
  const saved = db.transaction(() => store.store("image-a", "event", "event-a", body, "sync"));
  db.transaction(() => store.store("image-a", "event", "event-b", body, "sync"));
  db.transaction(() => store.store("image-b", "event", "event-c", body, "sync"));
  assert.equal(JSON.stringify(saved).includes(png), false);
  assert.equal(store.stats("image-a").usedBytes, Buffer.byteLength(png));
  assert.equal(store.stats("image-a").imageCount, 1);
  assert.deepEqual(store.hydrate("image-a", "event", "event-a", saved), body);
  assert.equal(JSON.stringify(store.hydrate("image-a", "event", "unbound-owner", saved)).includes(png), false);
  const url = "/api/machines/image-a/images";
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  const usage = (await app.inject({ method: "GET", url, headers })).json();
  assert.equal(usage.quotaBytes, 50_000_000);
  assert.equal((await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: usage.revision } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: -1, confirmCloudOnly: true } })).statusCode, 409);
  const cleared = await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: usage.revision, confirmCloudOnly: true } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().usedBytes, 0);
  assert.equal(cleared.json().nativeHistoryChanged, false);
  assert.equal(store.stats("image-b").imageCount, 1);
  assert.match(JSON.stringify(store.hydrate("image-a", "event", "event-a", saved)), /keep this text.*云端图片已清理/);
  const replay = db.transaction(() => store.store("image-a", "event", "replay", body, "sync"));
  assert.equal(JSON.stringify(replay).includes(png), false);
  assert.equal(store.stats("image-a").usedBytes, 0);
  assert.throws(() => store.stats("image-a", { workspaceId: "another-workspace" } as never), /主机不存在/);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM commands")!.count, 0, "clear never sends a native deletion command");
});

test("80 percent warning, hard quota, atomic rollback, text remains allowed, retention releases image content", async t => {
  const { db, store } = await fixture(t);
  db.transaction(() => store.store("image-a", "command", "synthetic", { images: [png] }, "command"));
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 39_999_999);
  assert.equal(store.stats("image-a").level, "normal");
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 40_000_000);
  assert.equal(store.stats("image-a").level, "warning");
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", CLOUD_IMAGE_QUOTA);
  assert.equal(store.stats("image-a").level, "full");
  assert.throws(() => db.transaction(() => store.store("image-a", "command", "new", { images: [second] }, "command")), /50 MB/);
  assert.equal(store.stats("image-a").imageCount, 1);
  // Lowering the quota never deletes existing images, including stores already over the limit.
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 50_000_001);
  assert.equal(store.stats("image-a").level, "full");
  const existing = db.transaction(() => store.store("image-a", "command", "reuse", { images: [png] }, "command"));
  assert.deepEqual(store.hydrate("image-a", "command", "reuse", existing), { images: [png] });
  assert.equal(store.stats("image-a").usedBytes, 50_000_001);
  assert.throws(() => db.transaction(() => store.store("image-a", "command", "over", { images: [second] }, "command")), /50 MB/);
  assert.deepEqual(db.transaction(() => store.store("image-a", "command", "text", { prompt: "text still works" }, "command")), { prompt: "text still works" });
  const sync = db.transaction(() => store.store("image-a", "event", "full-sync", { item: { type: "image", url: second } }, "sync"));
  assert.match(JSON.stringify(sync), /空间已满/);
  db.transaction(() => store.collect()); // synthetic owners no longer have live content
  assert.equal(store.stats("image-a").usedBytes, 0);
});

test("schema 19 inline command migration preserves payload bytes and is restart-safe", async t => {
  const { db, app, config, path, headers } = await fixture(t, true);
  const ws = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const user = db.get<{ user_id: string; client_session_id: string }>("SELECT user_id,client_session_id FROM client_sessions")!;
  const now = new Date().toISOString();
  db.run("UPDATE machines SET compatibility='compatible',reachability='online',capacity='idle',last_heartbeat_at=? WHERE machine_id='image-a'", now);
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'image-a','p','project','/tmp/fixture','fixture',?,?)", ws, now, now);
  const session = await app.inject({ method: "POST", url: "/api/sessions", headers, payload: { machineId: "image-a", projectId: "p", title: "migration" } });
  assert.equal(session.statusCode, 200, session.body);
  const s = session.json();
  db.run(`INSERT INTO commands(command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,logical_session_id,execution_segment_id,type,precondition_json,payload_json,created_at,expires_at)
    VALUES('old','old','wire-hash',?,?,?,?,?,'turn.start','{}','{}',?,?)`, ws, user.user_id, user.client_session_id, s.logicalSessionId, s.executionSegmentId, now, "2099-01-01T00:00:00Z");
  const payload = { prompt: "old image", images: [png] };
  db.run("INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES('old',?,?,'2099-01-01T00:00:00Z')", JSON.stringify(payload), now);
  db.sqlite.exec("DROP TABLE usage_days; DROP TABLE session_usage; DROP TABLE machine_usage; PRAGMA user_version=19");
  const migrated = new ControlPlaneDatabase(path); t.after(() => migrated.close());
  const normalized = JSON.parse(migrated.get<{ body_json: string }>("SELECT body_json FROM command_contents WHERE command_id='old'")!.body_json);
  assert.equal(JSON.stringify(normalized).includes(png), false);
  assert.deepEqual(new CloudImages(migrated).hydrate("image-a", "command", "old", normalized), payload);
  assert.equal(migrated.get<{ payload_hash: string }>("SELECT payload_hash FROM commands WHERE command_id='old'")!.payload_hash, "wire-hash");
  assert.equal(new CloudImages(migrated).stats("image-a").imageCount, 1);
  assert.equal(config.databasePath, path);
});

async function imageSessionFixture(t: import("node:test").TestContext) {
  const f=await fixture(t);const {app,db,headers,store}=f;
  const now=new Date().toISOString(); const ws=db.get<{workspace_id:string}>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const user=db.get<{user_id:string;client_session_id:string}>("SELECT user_id,client_session_id FROM client_sessions")!;
  db.run("UPDATE machines SET reachability='online',compatibility='compatible',capacity='idle',last_heartbeat_at=?,maintenance_types_json=? WHERE machine_id='image-a'",now,JSON.stringify(["images.preview","images.clean"]));
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'image-a','p','project','/tmp/fixture','fixture',?,?)",ws,now,now);
  async function add(name:string) {
    const response=await app.inject({method:"POST",url:"/api/sessions",headers,payload:{machineId:"image-a",projectId:"p",title:name}});assert.equal(response.statusCode,200,response.body);
    const session=response.json();const native="native-"+name;
    db.run("UPDATE execution_segments SET native_thread_id=? WHERE execution_segment_id=?",native,session.executionSegmentId);
    db.run(`INSERT INTO commands(command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,logical_session_id,execution_segment_id,type,precondition_json,payload_json,created_at,expires_at)
      VALUES(?,?,?, ?,?,?,?,?,'turn.start','{}','{}',?,'2099-01-01')`,name,name,"immutable",ws,user.user_id,user.client_session_id,session.logicalSessionId,session.executionSegmentId,now);
    db.run("INSERT INTO command_projection VALUES(?,'applied',?)",name,now);
    const body=store.store("image-a","command",name,{prompt:"保留文字",images:[png]},"command");
    db.run("INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES(?,?,?,'2099-01-01')",name,JSON.stringify(body),now);
    return {...session,native,body};
  }
  return {...f,add};
}

test("session cleanup requires matching host proof, preserves shared images and text, rejects stale scope",async t=>{
  const {app,db,headers,store,add}=await imageSessionFixture(t);
  const one=await add("one"),two=await add("two");
  const list=await app.inject({method:"GET",url:"/api/machines/image-a/images/sessions",headers});
  assert.equal(list.statusCode,200,list.body);assert.equal(list.json().sessions.length,2);
  const start=async(type:string,id:string,previewOperationId?:string)=>app.inject({method:"POST",url:"/api/machines/image-a/operations",headers,payload:{type,logicalSessionId:id,previewOperationId,clientMutationId:crypto.randomUUID()}});
  assert.equal((await start("images.clean",one.logicalSessionId)).statusCode,409);
  const previewResponse=await start("images.preview",one.logicalSessionId);assert.equal(previewResponse.statusCode,202,previewResponse.body);
  const previewId=previewResponse.json().operation.operationId;
  const request=JSON.parse(db.get<{request_json:string}>("SELECT request_json FROM machine_operations WHERE operation_id=?",previewId)!.request_json);
  const turns=[{turnId:"turn-one",hashes:request.uploads[0].hashes}];
  const proof={logicalSessionId:one.logicalSessionId,threadId:one.native,targets:turns,beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),byteOffsetsPreserved:true};
  const {MaintenanceService}=await import("../src/maintenance.js");const maintenance=new MaintenanceService(db);
  maintenance.result("image-a",previewId,"succeeded",proof,undefined);
  const cleanResponse=await start("images.clean",one.logicalSessionId,previewId);assert.equal(cleanResponse.statusCode,202,cleanResponse.body);
  const cleanId=cleanResponse.json().operation.operationId;
  assert.throws(()=>maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true,threadId:two.native},undefined),/不符/);
  assert.equal(store.stats("image-a").imageCount,1);
  maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true},undefined);
  maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true},undefined);
  assert.match(JSON.stringify(store.hydrate("image-a","command","one",one.body)),/保留文字.*图片已按会话清理/);
  assert.ok(JSON.stringify(store.hydrate("image-a","command","two",two.body)).includes(png),"unselected shared image remains");
  assert.equal(store.stats("image-a").imageCount,1);
  const replay=store.store("image-a","event","late",{item:{type:"image",url:png}},"sync",{logicalSessionId:one.logicalSessionId,nativeThreadId:one.native,nativeTurnId:"turn-one"});
  assert.ok(!JSON.stringify(replay).includes(png));assert.match(JSON.stringify(replay),/图片已按会话清理/);
  const anotherTurn=store.store("image-a","event","another",{item:{type:"image",url:png}},"sync",{logicalSessionId:one.logicalSessionId,nativeThreadId:one.native,nativeTurnId:"turn-other"});
  assert.ok(JSON.stringify(store.hydrate("image-a","event","another",anotherTurn)).includes(png));
  assert.equal((await start("images.clean",one.logicalSessionId,previewId)).statusCode,409,"cleaned scope cannot be silently reused");
  assert.equal(db.get<{payload_hash:string}>("SELECT payload_hash FROM commands WHERE command_id='one'")!.payload_hash,"immutable");
});

test("image session list covers all pages and enforces host ownership and pending commands",async t=>{
  const {app,db,headers,add}=await imageSessionFixture(t);
  for(let i=0;i<52;i++) await add("session-"+i);
  const first=await app.inject({url:"/api/machines/image-a/images/sessions",headers});
  assert.equal(first.json().sessions.length,50);assert.ok(first.json().nextCursor);
  const last=await app.inject({url:"/api/machines/image-a/images/sessions?cursor="+first.json().nextCursor,headers});
  assert.equal(last.json().sessions.length,2);assert.equal(last.json().nextCursor,null);
  const id=first.json().sessions[0].logicalSessionId;
  db.run("UPDATE command_projection SET state='unknown' WHERE command_id IN (SELECT command_id FROM commands WHERE logical_session_id=?)",id);
  const result=await app.inject({method:"POST",url:"/api/machines/image-a/operations",headers,payload:{type:"images.preview",logicalSessionId:id,clientMutationId:crypto.randomUUID()}});
  assert.equal(result.statusCode,409);assert.equal(result.json().error.code,"IMAGE_COMMAND_PENDING");
  assert.equal((await app.inject({url:"/api/machines/image-b/images/sessions",headers})).json().sessions.length,0);
});

test("attachment storage reports host and session files by actual extension", async t => {
  const { app, db, headers, store, add, config } = await imageSessionFixture(t);
  const session = await add("typed-files");
  for (const [path, size, hash] of [["reports/guide.pdf", 1200, "a".repeat(64)], ["books/data.xlsx", 3400, "b".repeat(64)], ["src/main.ts", 200, "c".repeat(64)] ] as const) {
    db.run("INSERT INTO attachment_uploads(machine_id,logical_session_id,execution_segment_id,command_id,relative_path,size_bytes,content_hash) VALUES('image-a',?,?,?,?,?,?)", session.logicalSessionId, session.executionSegmentId, "typed-files", path, size, hash);
  }
  const stats = store.stats("image-a");
  assert.equal(stats.fileCount, 3); assert.equal(stats.fileBytes, 4800);
  assert.deepEqual(stats.fileTypes, [{type:"XLSX",count:1,bytes:3400},{type:"PDF",count:1,bytes:1200},{type:"TS",count:1,bytes:200}]);
  const response = await app.inject({method:"GET",url:"/api/machines/image-a/images/sessions",headers});
  assert.equal(response.statusCode, 200, response.body);
  const row = response.json().sessions.find((value:{logicalSessionId:string}) => value.logicalSessionId === session.logicalSessionId);
  assert.deepEqual(row.fileTypes, stats.fileTypes);
});

test("version maintenance is host scoped, capability gated and excludes concurrent cleanup",async t=>{
 const {app,db,headers}=await fixture(t);
 const start=(type:string,extra={})=>app.inject({method:'POST',url:'/api/machines/image-a/operations',headers,payload:{type,clientMutationId:crypto.randomUUID(),...extra}});
 db.run("UPDATE machines SET reachability='online',maintenance_types_json='[]' WHERE machine_id='image-a'");
 assert.equal((await start('versions.preview')).statusCode,409);
 db.run("UPDATE machines SET maintenance_types_json=? WHERE machine_id='image-a'",JSON.stringify(['versions.preview','versions.clean']));
 assert.equal((await start('versions.clean',{logicalSessionId:'anything'})).statusCode,400);
 const first=await start('versions.preview');assert.equal(first.statusCode,202,first.body);
 assert.equal((await start('versions.clean')).statusCode,409);
 const {MaintenanceService}=await import('../src/maintenance.js');
 const maintenance=new MaintenanceService(db);
 maintenance.result('image-a',first.json().operation.operationId,'succeeded',{reclaimableBytes:123},undefined);
 const cleaned=await start('versions.clean');assert.equal(cleaned.statusCode,202,cleaned.body);
 assert.equal(db.all('PRAGMA foreign_key_check').length,0);
 assert.equal((await app.inject({method:'POST',url:'/api/machines/image-a/operations',payload:{type:'versions.clean',clientMutationId:crypto.randomUUID()}})).statusCode,401);
});

test('provider runtime operations use auth/CSRF, workspace scope, strict arguments and mutation idempotency',async t=>{
 const {app,db,headers}=await fixture(t);
 db.run("UPDATE machines SET reachability='online',maintenance_types_json=? WHERE machine_id='image-a'",JSON.stringify(['provider.runtime']));
 const payload={type:'provider.runtime',clientMutationId:'provider-check-unique',nativeRequest:{action:'check'}};
 const start=(data=payload,h=headers,id='image-a')=>app.inject({method:'POST',url:`/api/machines/${id}/operations`,headers:h,payload:data});
 assert.equal((await start(payload,{} as typeof headers)).statusCode,401);
 assert.equal((await start(payload,{cookie:headers.cookie} as typeof headers)).statusCode,403);
 assert.equal((await start(payload,headers,'unknown-host')).statusCode,404);
 assert.equal((await start({...payload,nativeRequest:{action:'check',url:'https://evil'} as never})).statusCode,400);
 const first=await start();assert.equal(first.statusCode,202,first.body);
 const duplicate=await start();assert.equal(duplicate.json().operation.operationId,first.json().operation.operationId);
 assert.equal((await start({...payload,nativeRequest:{action:'configure',provider:'claude',mode:'auto',expectedRevision:0} as never})).statusCode,409);
 assert.equal((await start({...payload,clientMutationId:'second-request'})).statusCode,409);
 const {MaintenanceService}=await import('../src/maintenance.js');const service=new MaintenanceService(db);
 assert.deepEqual(service.offers('image-a')[0]?.recoveryTarget,{action:'check'});
 service.result('image-a',first.json().operation.operationId,'succeeded',{checkedAt:new Date().toISOString(),providers:{}},undefined);
 assert.equal((await start({...payload,clientMutationId:'unverified-request',nativeRequest:{action:'configure',provider:'claude',mode:'auto',expectedRevision:0} as never})).statusCode,409);
 db.run("UPDATE machines SET discovery_json=? WHERE machine_id='image-a'",JSON.stringify({managedEligibilitySupport:true,managedEligibility:{claude:{state:'ready',checkedAt:new Date().toISOString()}}}));
 const next=await start({...payload,clientMutationId:'second-request',nativeRequest:{action:'configure',provider:'claude',mode:'auto',expectedRevision:0} as never});assert.equal(next.statusCode,202,next.body);
 assert.ok(db.get("SELECT 1 FROM audit_entries WHERE action='machine.operation.request' AND machine_id='image-a'"));
});


test("browser image links preserve native inputs and original pixels; conditional reads recheck ownership and cleanup", async t => {
  const { app, db, headers, store, add, config } = await imageSessionFixture(t);
  const session = await add("delivery");
  const other = await add("other-delivery");
  const workspaceId = db.get<{workspace_id:string}>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const now = new Date().toISOString();
  const generated = "data:image/png;base64," + Buffer.concat([Buffer.from(png.split(",")[1]!, "base64"), Buffer.alloc(500_000)]).toString("base64");
  for (const [index, image, type] of [[1, png, "userMessage"], [2, generated, "imageGeneration"]] as const) {
    const content = {item:{id:`image-${index}`,type,status:"completed",content:[{type:"text",text:"Keep all context"},{type:"image",url:image}]}};
    const ref = `delivery-ref-${index}`;
    const stored = store.store("image-a", "event", ref, content, "sync");
    db.run("INSERT INTO content_blobs VALUES(?,?,?,?,?,?,NULL)", ref, workspaceId, JSON.stringify(stored), "hash", now, "2099-01-01");
    db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,native_thread_id,native_turn_id,native_item_id,type,schema_version,occurred_at,received_at,payload_ref,payload_state)
      VALUES(?,'hash','agent',?,?,?,'image-a','p',?,1,?,'delivery-turn',?,'item.completed','1',?,?,?,'present')`,
      `delivery-event-${index}`, workspaceId, session.logicalSessionId, session.executionSegmentId, index, session.native, `image-${index}`, now, now, ref);
    assert.deepEqual(store.hydrate("image-a", "event", ref, stored), content);
  }
  db.run("UPDATE logical_sessions SET next_session_seq=3 WHERE logical_session_id=?", session.logicalSessionId);
  const history = `/api/sessions/${session.logicalSessionId}/events?limit=100&compact=1`;
  const legacy = await app.inject({url:history,headers});
  const compact = await app.inject({url:history+"&images=links",headers});
  assert.equal(compact.statusCode,200,compact.body);
  assert.ok(legacy.body.includes(generated));
  assert.equal(compact.body.includes("base64"),false);
  assert.ok(compact.body.length < legacy.body.length / 100);
  assert.equal(compact.json().items[0].payload.item.content[0].text,"Keep all context");
  const delta = await app.inject({url:history+"&images=links&afterSeq=1&projectionEpoch=1&contentEpoch=1",headers});
  assert.equal(delta.statusCode,200,delta.body);
  assert.deepEqual(delta.json().items,[compact.json().items[1]]);
  const url = compact.json().items[1].payload.item.content[1].url;
  const first = await app.inject({url,headers});
  assert.equal(first.statusCode,200,first.body.slice(0,100));
  assert.equal(first.headers["cache-control"],"private, no-cache");
  assert.equal(first.headers["content-type"],"image/png");
  assert.deepEqual(first.rawPayload,Buffer.from(generated.split(",")[1]!,"base64"));
  const conditional = {...headers,"if-none-match":first.headers.etag as string};
  const cached = await app.inject({url,headers:conditional});
  assert.equal(cached.statusCode,304); assert.equal(cached.rawPayload.length,0);
  assert.equal((await app.inject({url,headers:{"if-none-match":first.headers.etag as string}})).statusCode,401);
  assert.equal((await app.inject({url:url.replace(session.logicalSessionId,other.logicalSessionId),headers:conditional})).statusCode,404);
  assert.equal((await app.inject({url:url.replace("delivery-event-2","delivery-event-1"),headers:conditional})).statusCode,404,"hash must belong to the specific event");
  for (const [change,restore] of [
    ["UPDATE projects SET sync_content=0", "UPDATE projects SET sync_content=1"],
    ["UPDATE content_blobs SET expires_at='2000-01-01'", "UPDATE content_blobs SET expires_at='2099-01-01'"],
    ["UPDATE content_blobs SET deleted_at='2000-01-01'", "UPDATE content_blobs SET deleted_at=NULL"],
    ["UPDATE logical_sessions SET deleted_at='2000-01-01'", "UPDATE logical_sessions SET deleted_at=NULL"],
    ["UPDATE logical_sessions SET content_epoch=2", "UPDATE logical_sessions SET content_epoch=1"],
    ["UPDATE durable_events SET payload_state='suppressed'", "UPDATE durable_events SET payload_state='present'"],
  ]) {
    db.run(change!); const denied = await app.inject({url,headers:conditional});
    assert.equal(denied.statusCode,404,change); assert.equal(denied.headers["cache-control"],"no-store"); db.run(restore!);
  }
  // Reading the panel never rewrites image records or native command payloads.
  const principal = new AuthService(db,config).servicePrincipal("image-delivery-test");
  const command = new CoordinationService(db,config).getCommand(principal,"delivery");
  assert.deepEqual(command.payload,{prompt:"保留文字",images:[png]});
  assert.throws(() => parseImages([url]), /图片格式/);
  assert.throws(() => readEventImage(db,{...principal,workspaceId:"foreign"},session.logicalSessionId,"delivery-event-2",url.split("/").at(-1)!),{code:"IMAGE_UNAVAILABLE"});
  assert.deepEqual(store.hydrate("image-a","command","delivery",session.body),{prompt:"保留文字",images:[png]});
  const hash = url.split("/").at(-1)!;
  db.run("INSERT INTO image_cleaned_turns(machine_id,logical_session_id,native_thread_id,native_turn_id,image_hash) VALUES(?,?,?,?,?)","image-a",session.logicalSessionId,session.native,"delivery-turn",hash);
  assert.equal((await app.inject({url,headers:conditional})).statusCode,404);
  db.run("DELETE FROM image_cleaned_turns");
  const cleared = await app.inject({method:"POST",url:"/api/machines/image-a/images/clear",headers,payload:{revision:store.stats("image-a").revision,confirmCloudOnly:true}});
  assert.equal(cleared.statusCode,200,cleared.body);
  assert.equal((await app.inject({url,headers:conditional})).statusCode,404);
  assert.equal((await app.inject({url:history+"&images=links",headers})).body.includes("/images/"),false);
});
