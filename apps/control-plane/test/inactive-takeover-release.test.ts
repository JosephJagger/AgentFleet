import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneDatabase } from "./database-fixture.js";
import { CoordinationService } from "../src/coordination.js";
import { loadConfig } from "../src/config.js";
import { COMMAND_TYPES } from "../src/api-schema.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const db = new ControlPlaneDatabase(":memory:");
  t.after(() => db.close());
  const config = loadConfig({ AUTH_MODE: "password",
    ADMIN_EMAIL: "owner@example.test",
    ADMIN_PASSWORD: "correct horse battery staple",
    PUBLIC_ORIGIN: "http://control-plane.test",
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
  });
  const owner = db.bootstrap(config);
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * 60 * 60 * 1_000).toISOString();
  db.run(
    "INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('client-auto',?,?,?,?,?,?,?)",
    owner.workspaceId, owner.userId, "token-auto", "csrf-auto", at(-400), at(-1), at(24),
  );
  db.run(
    `INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,
      identity_state,security_state,reachability,compatibility,capacity,last_heartbeat_at,created_at,updated_at,command_types_json)
     VALUES('machine-auto',?,'key','fingerprint','Auto host','linux','25.04','x64','0.30.0','active','normal','online','compatible','idle',?,?,?,?)`,
    owner.workspaceId, at(-400), at(-400), at(-400), JSON.stringify(COMMAND_TYPES),
  );
  db.run(
    "INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,lease_version,created_at,last_reported_at) VALUES('project-auto',?,'machine-auto','project','Project','/project','project-hash',1,?,?)",
    owner.workspaceId, at(-400), at(-400),
  );
  const addSession = (id: string) => {
    db.run(
      "INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?, 'machine-auto','project-auto',?,?,1,'idle','live',?,?)",
      id, owner.workspaceId, id, id, at(-400), at(-400),
    );
    db.run(
      "INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,history_completeness,created_at) VALUES(?,?,'machine-auto','project-auto',?,?, 'complete',?)",
      `segment-${id}`, id, id, `native-${id}`, at(-400),
    );
  };
  return { db, config, owner, now, at, addSession };
}

test("default fourteen-day inactivity schedules only release, without deleting sessions or history", t => {
  const {db,config,now,at,addSession}=fixture(t);
  addSession("stale-session");
  addSession("recent-session");
  addSession("pending-session");
  db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('stale-session',?,?,100,'observation')", at(-400), at(-337));
  db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('recent-session',?,?,100,'observation')", at(-2), at(-1));
  db.run("INSERT INTO approvals(approval_id,logical_session_id,execution_segment_id,action_hash,app_server_epoch,version,context_json,state,created_at) VALUES('approval-auto','pending-session','segment-pending-session','hash','epoch',1,'{}','pending',?)", at(-1));

  const service = new CoordinationService(db, config);
  const before = db.all("SELECT logical_session_id,managed,deleted_at FROM logical_sessions ORDER BY logical_session_id");
  const result = service.releaseInactiveTakeovers(now);
  assert.deepEqual(db.all("SELECT logical_session_id,managed,deleted_at FROM logical_sessions ORDER BY logical_session_id"),before);


  assert.equal(result.scanned, 1);
  assert.equal(result.scheduled, 1);
  const command = db.get<{ type: string; logical_session_id: string; state: string }>(
    "SELECT c.type,c.logical_session_id,cp.state FROM commands c JOIN command_projection cp ON cp.command_id=c.command_id",
  );
  assert.equal(command?.type, "thread.release");
  assert.equal(command?.logical_session_id, "stale-session");
  assert.equal(command?.state, "accepted");
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM commands WHERE logical_session_id='recent-session'")?.count, 0);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM commands WHERE logical_session_id='pending-session'")?.count, 0);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM audit_entries WHERE action='thread.auto_release.inactive'")?.count, 1);
});

test("workspace policy uses custom days and a recent takeover supersedes old token usage", t => {
  const {db,config,owner,now,at,addSession}=fixture(t);
  db.run("INSERT INTO takeover_policies VALUES(?,21,1,?)",owner.workspaceId,at(0));
  addSession("session");
  db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('session',?,?,100,'observation')",at(-400),at(-350));
  const service=new CoordinationService(db,config);
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,0,"21 days not reached");
  db.run("UPDATE takeover_policies SET idle_days=3");
  db.run(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,type,schema_version,occurred_at,received_at,payload_state)
    VALUES('reclaim','hash','agent',?,'session','segment-session','machine-auto','project-auto',1,1,'thread.claimed','1.0',?,?,'suppressed')`,owner.workspaceId,at(-1),at(-1));
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,0,"new takeover resets clock");
  assert.equal(service.releaseInactiveTakeovers(now+71*3600000).scheduled,1,"eligible at exactly 72 hours after takeover");
});

test("active global voice, offline host and active turns defer automatic release",t=>{
  const {db,config,owner,now,at,addSession}=fixture(t);addSession("session");
  const service=new CoordinationService(db,config);
  db.run("INSERT INTO panel_voice_calls(voice_id,workspace_id,user_id,owner_id,machine_id,binding_json,state,created_at) VALUES('voice',?,?,'client-auto','machine-auto','{}','active',?)",owner.workspaceId,owner.userId,at(-1));
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,0);
  db.run("UPDATE panel_voice_calls SET state='closed'");
  db.run("UPDATE machines SET reachability='offline'");
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,0);
  db.run("UPDATE machines SET reachability='online'");
  db.run("UPDATE logical_sessions SET active_turn_id='turn',execution_state='running'");
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,0);
  db.run("UPDATE logical_sessions SET active_turn_id=NULL,execution_state='idle'");
  assert.equal(service.releaseInactiveTakeovers(now).scheduled,1);
  assert.equal(db.get<{deleted_at:string|null}>("SELECT deleted_at FROM logical_sessions")?.deleted_at,null);
});

test("saving takeover policy never changes project retention or releases a session immediately",async t=>{
  const {TakeoverPolicy}=await import("../src/takeover-policy.js");
  const {db,owner,addSession}=fixture(t);addSession("session");
  db.run("UPDATE projects SET retention_days=30");
  const before=db.all("SELECT * FROM logical_sessions");
  new TakeoverPolicy(db).save({...owner,clientSessionId:"client-auto",email:"owner@example.test",csrfHash:"",expiresAt:""},{idleDays:7,revision:0});
  assert.deepEqual(db.all("SELECT * FROM logical_sessions"),before);
  assert.equal(db.get<{retention_days:number}>("SELECT retention_days FROM projects")?.retention_days,30);
  assert.equal(db.get<{count:number}>("SELECT count(*) AS count FROM commands")?.count,0);
});
