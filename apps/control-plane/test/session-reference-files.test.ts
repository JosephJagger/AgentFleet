import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceFiles, parseReferences } from "../src/session-reference-files.js";
import { ControlPlaneDatabase } from "../src/db.js";
import { CoordinationService } from "../src/coordination.js";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/auth.js";

const id = `ls_${"a".repeat(32)}`;
const principal = { workspaceId: "ws_1" } as Principal;
const row = { title: "Source", host_name: "Host", project_alias: "Project", projection_epoch: 1, content_epoch: 2, next_session_seq: 4, history_completeness: "partial" };
function event(seq: number, type: string, text: string) { return { sessionSeq: seq, payloadState: "present", payload: { item: type === "userMessage" ? { type, content: [{ type: "text", text }] } : { type, text } } }; }

test("creates an ordered, scoped file without model calls or command output", () => {
  const db = { get: (_sql: string, sourceId: string, workspaceId: string) => sourceId === id && workspaceId === principal.workspaceId ? row : undefined } as unknown as ControlPlaneDatabase;
  const coordination = { historyPage: (_principal: Principal, sourceId: string, options: { beforeSeq?: number }) => {
    assert.equal(sourceId, id);
    return options.beforeSeq ? { items: [event(1, "userMessage", "first")], nextBeforeSeq: null, throughSeq: 3 } : { items: [event(2, "commandExecution", "omit secret"), event(3, "agentMessage", "last")], nextBeforeSeq: 2, throughSeq: 3 };
  } } as unknown as CoordinationService;
  const files = buildReferenceFiles(db, coordination, principal, parseReferences([{ id, version: "1:2:3" }]));
  const text = Buffer.from(files[0]!.data, "base64").toString();
  assert.ok(text.indexOf("first") < text.indexOf("last"));
  assert.doesNotMatch(text, /omit secret/);
  assert.match(text, /Partial/);
  assert.equal(files[0]!.name, `reference-1-${id}.md`);
});

test("rejects stale, cross-workspace and oversized references", () => {
  const db = { get: (_sql: string, sourceId: string, workspaceId: string) => sourceId === id && workspaceId === principal.workspaceId ? row : undefined } as unknown as ControlPlaneDatabase;
  const coordination = { historyPage: () => ({ items: [event(1, "userMessage", "x".repeat(4 * 1024 * 1024))], nextBeforeSeq: null, throughSeq: 3 }) } as unknown as CoordinationService;
  assert.throws(() => buildReferenceFiles(db, coordination, principal, [{ id, version: "1:2:2" }]), /changed/);
  assert.throws(() => buildReferenceFiles(db, coordination, { workspaceId: "other" } as Principal, [{ id, version: "1:2:3" }]), /unavailable/);
  assert.throws(() => buildReferenceFiles(db, coordination, principal, [{ id, version: "1:2:3" }]), /safe file limit/);
  assert.throws(() => parseReferences([{ id, version: "1:2:3" }, { id, version: "1:2:3" }]), /duplicate/);
});


test("cross-host reference submission uses real schema and the current execution segment", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const config = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "owner@example.test",
    ADMIN_PASSWORD: "correct horse battery staple", PUBLIC_ORIGIN: "http://control-plane.test",
    COOKIE_SECURE: "false", LOG_LEVEL: "silent" });
  const owner = db.bootstrap(config), now = new Date().toISOString(), expires = new Date(Date.now()+86400000).toISOString();
  const user = { ...principal, ...owner, clientSessionId: "client-reference" } as Principal;
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    user.clientSessionId,owner.workspaceId,owner.userId,"token","csrf",now,now,expires);
  const target = `ls_${"b".repeat(32)}`;
  for (const [host, sid] of [["source", id], ["target", target]] as const) {
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,
      identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at,command_types_json,codex_catalog_json)
      VALUES(?,?,?,?,?,'linux','1','x64','0.30.50','active','normal','online','compatible','idle',?,?,?,?)`,
      host,owner.workspaceId,host,host,host,now,now,JSON.stringify(["turn.start","turn.queue","turn.steer"]),JSON.stringify({fileInput:true,models:[],modes:[],fetchedAt:now}));
    db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES(?,?,?,?,?,?,?,?,?)",
      host,owner.workspaceId,host,host,host,"/"+host,host,now,now);
    db.run("INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,next_session_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,1,'idle','live',2,?,?)",
      sid,owner.workspaceId,host,host,sid,host,now,now);
    db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,history_completeness,native_thread_id,created_at) VALUES(?,?,?,?,?,?,?)",
      host,sid,host,host,"partial","native-"+host,now);
  }
  // An ended segment must not supply the source history status.
  db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,history_completeness,created_at,ended_at) VALUES('old',?,'source','source','complete','2000-01-01',?)",id,now);
  db.run("INSERT INTO content_blobs(payload_ref,workspace_id,body_json,payload_hash,created_at,expires_at) VALUES('body',?,?, 'hash',?,?)",
    owner.workspaceId,JSON.stringify({item:{type:"userMessage",content:[{type:"text",text:"source task context"}]}}),now,expires);
  db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,type,schema_version,occurred_at,received_at,payload_ref,payload_state)
    VALUES('event','hash','agent',?,?,'source','source','source',1,1,'item.completed','1',?,?,'body','present')`,owner.workspaceId,id,now,now);
  const service=new CoordinationService(db,config);
  const lease=service.acquireLease(user,target);
  const input={type:"turn.start" as const,clientMutationId:"reference-submission-1",controlLeaseId:lease.leaseId,
    payload:{prompt:"接管以上会话",references:[{id,version:"1:1:1"}]},
    precondition:{executionSegmentId:"target",threadControlVersion:1,expectedActiveTurnId:null,projectLeaseVersion:1}};
  const result=service.createCommand(user,target,input);
  assert.equal(result.command.state,"accepted");
  const payload=result.command.payload as {prompt:string;attachments:{data:string}[]};
  assert.match(payload.prompt,/接管以上会话/);
  const text=Buffer.from(payload.attachments[0]!.data,"base64").toString();
  assert.match(text,/Host: source/);assert.match(text,/source task context/);assert.match(text,/Partial/);
  assert.equal(service.createCommand(user,target,input).duplicate,true);
  assert.throws(()=>buildReferenceFiles(db,service,{...user,workspaceId:"other"},[{id,version:"1:1:1"}]),/unavailable/);
  db.run("UPDATE logical_sessions SET deleted_at=? WHERE logical_session_id=?",now,id);
  assert.throws(()=>buildReferenceFiles(db,service,user,[{id,version:"1:1:1"}]),/unavailable/);
  db.close();
});
