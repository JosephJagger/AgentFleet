import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlaneDatabase } from "../src/db.js";
import { CoordinationService } from "../src/coordination.js";
import { loadConfig } from "../src/config.js";
import { COMMAND_TYPES } from "../src/api-schema.js";

test("three days without recorded token use schedules a safe native takeover release", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const config = loadConfig({
    ADMIN_EMAIL: "owner@example.test",
    ADMIN_PASSWORD: "correct horse battery staple",
    PUBLIC_ORIGIN: "http://control-plane.test",
    COOKIE_SECURE: "false",
    LOG_LEVEL: "silent",
  });
  const owner = db.bootstrap(config);
  const now = Date.parse("2026-09-17T12:00:00.000Z");
  const at = (hours: number) => new Date(now + hours * 60 * 60 * 1_000).toISOString();
  db.run(
    "INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('client-auto',?,?,?,?,?,?,?)",
    owner.workspaceId, owner.userId, "token-auto", "csrf-auto", at(-100), at(-1), at(24),
  );
  db.run(
    `INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,
      identity_state,security_state,reachability,compatibility,capacity,last_heartbeat_at,created_at,updated_at,command_types_json)
     VALUES('machine-auto',?,'key','fingerprint','Auto host','linux','25.04','x64','0.30.0','active','normal','online','compatible','idle',?,?,?,?)`,
    owner.workspaceId, at(-100), at(-100), at(-100), JSON.stringify(COMMAND_TYPES),
  );
  db.run(
    "INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,lease_version,created_at,last_reported_at) VALUES('project-auto',?,'machine-auto','project','Project','/project','project-hash',1,?,?)",
    owner.workspaceId, at(-100), at(-100),
  );
  const addSession = (id: string) => {
    db.run(
      "INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?, 'machine-auto','project-auto',?,?,1,'idle','live',?,?)",
      id, owner.workspaceId, id, id, at(-100), at(-100),
    );
    db.run(
      "INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,history_completeness,created_at) VALUES(?,?,'machine-auto','project-auto',?,?, 'complete',?)",
      `segment-${id}`, id, id, `native-${id}`, at(-100),
    );
  };
  addSession("stale-session");
  addSession("recent-session");
  addSession("pending-session");
  db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('stale-session',?,?,100,'observation')", at(-100), at(-73));
  db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('recent-session',?,?,100,'observation')", at(-2), at(-1));
  db.run("INSERT INTO approvals(approval_id,logical_session_id,execution_segment_id,action_hash,app_server_epoch,version,context_json,state,created_at) VALUES('approval-auto','pending-session','segment-pending-session','hash','epoch',1,'{}','pending',?)", at(-1));

  const service = new CoordinationService(db, config);
  const result = service.releaseInactiveTakeovers(now);

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
