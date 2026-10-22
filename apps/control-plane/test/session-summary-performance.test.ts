import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { RegistryService } from "../src/registry.js";

const config = () => loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "summary@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: "http://summary.test", COOKIE_SECURE: "false" });

test("session summaries use an indexed terminal timestamp and preserve event-time ordering across migration", t => {
  const directory = mkdtempSync(join(tmpdir(), "session-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "db.sqlite");
  let db = new ControlPlaneDatabase(path);
  t.after(() => db.close());
  const settings = config();
  const { workspaceId, userId } = db.bootstrap(settings);
  const at = new Date().toISOString();
  const principal = { workspaceId, userId, clientSessionId: "test-client", email: "summary@example.test", csrfHash: "", expiresAt: at };
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES('m',?,'key','fingerprint','host','linux','6','x64',?,?)`, workspaceId, at, at);
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at)
    VALUES('p',?,'m','external','project','/work','identity',?,?)`, workspaceId, at, at);
  for (const id of ["history", "empty"]) {
    db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at)
      VALUES(?,?,'m','p',?,1,'idle','live',?,?)`, id, workspaceId, id, at, at);
    db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,created_at) VALUES(?,?,'m','p',?)", `segment-${id}`, id, at);
  }
  const insert = db.sqlite.prepare(`INSERT INTO durable_events(event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,machine_id,project_id,session_seq,projection_epoch,type,schema_version,occurred_at,received_at,payload_state)
    VALUES(?,'hash','agent',?,'history','segment-history','m','p',?,1,?,'1',?,?,'suppressed')`);
  db.transaction(() => {
    for (let i = 1; i <= 1_000; i++) insert.run(`event-${i}`, workspaceId, i, "item.output.delta", "2026-10-22T12:00:00.000Z", at);
    // A late replay of an older terminal event must not replace the latest time.
    insert.run("completed", workspaceId, 1_001, "turn.completed", "2026-10-20T12:00:00.000Z", at);
    insert.run("interrupted", workspaceId, 1_002, "turn.interrupted", "2026-10-21T12:00:00.000Z", at);
    insert.run("failed-replay", workspaceId, 1_003, "turn.failed", "2026-10-19T12:00:00.000Z", at);
  });
  // Exercise an actual v70 -> v71 upgrade with existing event history.
  db.sqlite.exec("DROP INDEX durable_events_terminal_time_idx; PRAGMA user_version=70");
  db.close();
  db = new ControlPlaneDatabase(path);
  assert.equal(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version, 72);
  const originalGet = db.get.bind(db);
  let summarySql = "";
  t.mock.method(db, "get", (sql: string, ...values: SQLInputValue[]) => {
    if (sql.includes("AS last_turn_ended_at")) summarySql = sql;
    return originalGet(sql, ...values);
  });
  const registry = new RegistryService(db, settings);
  assert.equal(registry.getSession(principal, "history").lastTurnEndedAt, "2026-10-21T12:00:00.000Z");
  assert.equal(registry.getSession(principal, "empty").lastTurnEndedAt, null);
  const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${summarySql}`, "history", workspaceId);
  assert.ok(plan.some(row => row.detail.includes("durable_events_terminal_time_idx")), JSON.stringify(plan));
  assert.equal(db.get<{ total: number }>("SELECT count(*) AS total FROM durable_events")?.total, 1_003);
  db.run("DELETE FROM durable_events WHERE event_id='interrupted'");
  assert.equal(registry.getSession(principal, "history").lastTurnEndedAt, "2026-10-20T12:00:00.000Z");
  assert.throws(() => registry.getSession({ ...principal, workspaceId: "other-workspace" }, "history"), /not found/);
});
