import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";
import type { ControlPlaneConfig } from "../src/config.js";
import { nextOccurrence, validateSchedule } from "../src/scheduled-tasks.js";
import { ScheduledTasksService } from "../src/scheduled-tasks.js";
import { AuthService } from "../src/auth.js";
import { RegistryService } from "../src/registry.js";
import { CoordinationService } from "../src/coordination.js";

const origin = "http://scheduled.test";
const config = (): ControlPlaneConfig => ({
  host: "127.0.0.1", port: 3000, databasePath: ":memory:", publicOrigin: origin, allowedOrigins: new Set([origin]),
  adminEmail: "admin@example.test", adminPassword: "correct horse battery staple", cookieName: "scheduled_test", cookieSecure: false,
  sessionTtlSeconds: 3600, controlLeaseTtlSeconds: 45, pairTtlSeconds: 600, challengeTtlSeconds: 60,
  ticketTtlSeconds: 30, heartbeatOfflineSeconds: 45, logLevel: "silent",
});

test("calendar schedules honor weekdays and local DST rather than fixed UTC days", () => {
  const schedule = validateSchedule({ kind: "weekdays", time: "09:00" }, "America/New_York");
  assert.equal(nextOccurrence(schedule, "America/New_York", new Date("2026-03-06T15:00:00Z")), "2026-03-09T13:00:00.000Z");
  const weekly = validateSchedule({ kind: "weekly", time: "08:30", weekdays: [1, 3] }, "Asia/Shanghai");
  assert.equal(nextOccurrence(weekly, "Asia/Shanghai", new Date("2026-09-24T00:00:00Z")), "2026-09-28T00:30:00.000Z");
  const minutes = validateSchedule({ kind: "minutes", everyMinutes: 30, startsAt: "2026-09-24T00:00:00Z" }, "UTC");
  assert.equal(nextOccurrence(minutes, "UTC", new Date("2026-09-24T00:43:00Z")), "2026-09-24T01:00:00.000Z");
});

test("offline scheduled run is held once, expires after 24 hours, and creates a notification", async t => {
  const { app, db, runMaintenance } = await buildControlPlane(config());
  await app.ready();
  t.after(async () => app.close());
  const workspace = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces LIMIT 1")!.workspace_id;
  const now = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, "mach_schedule", workspace, "spki_schedule", "finger_schedule", "Offline host", "linux", "1", "x64", now, now);
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, "project_schedule", workspace, "mach_schedule", "external_schedule", "Project", "/tmp/scheduled", "identity_schedule", now, now);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "admin@example.test", password: "correct horse battery staple" } });
  assert.equal(login.statusCode, 200);
  const cookie = cookieFromSetCookie(login.headers["set-cookie"]);
  const headers = { cookie, ...csrfHeaders((JSON.parse(login.body) as { csrfToken: string }).csrfToken, origin) };
  const create = await app.inject({ method: "POST", url: "/api/scheduled-tasks", headers, payload: {
    projectId: "project_schedule", title: "Daily check", prompt: "Check the project", timezone: "UTC",
    schedule: { kind: "minutes", everyMinutes: 1, startsAt: new Date(Date.now() + 60_000).toISOString() },
  } });
  assert.equal(create.statusCode, 200, create.body);
  const taskId = (JSON.parse(create.body) as { task: { id: string } }).task.id;
  db.run("UPDATE scheduled_tasks SET next_at=? WHERE task_id=?", new Date(Date.now() - 60_000).toISOString(), taskId);
  runMaintenance();
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_runs WHERE task_id=? AND status='pending'", taskId)?.count, 1);
  runMaintenance();
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_runs WHERE task_id=?", taskId)?.count, 1);
  db.run("UPDATE scheduled_runs SET scheduled_at=? WHERE task_id=?", new Date(Date.now() - 25 * 3600_000).toISOString(), taskId);
  runMaintenance();
  assert.equal(db.get<{ status: string }>("SELECT status FROM scheduled_runs WHERE task_id=?", taskId)?.status, "missed");
  const notes = await app.inject({ method: "GET", url: "/api/scheduled-notifications", headers: { cookie } });
  assert.equal((JSON.parse(notes.body) as { unread: number }).unread, 1);
  const read = await app.inject({ method: "POST", url: "/api/scheduled-notifications/read", headers, payload: {} });
  assert.equal(read.statusCode, 200);
  const after = await app.inject({ method: "GET", url: "/api/scheduled-notifications", headers: { cookie } });
  assert.equal((JSON.parse(after.body) as { unread: number }).unread, 0);
});

test("two due tasks in one project dispatch only one turn and retain the other", async t => {
  const settings = config();
  const { app, db } = await buildControlPlane(settings);
  await app.ready();
  t.after(async () => app.close());
  const workspace = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces LIMIT 1")!.workspace_id;
  const now = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "mach_schedule_online", workspace, "spki_schedule_online", "finger_schedule_online", "Online host", "linux", "1", "x64", "online", "compatible", '["turn.start"]', now, now, now);
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, "project_schedule_online", workspace, "mach_schedule_online", "external_schedule_online", "Project", "/tmp/scheduled-online", "identity_schedule_online", now, now);
  const principal = new AuthService(db, settings).servicePrincipal("scheduled_test");
  const dispatched: string[] = [];
  const service = new ScheduledTasksService(db, new RegistryService(db, settings), new CoordinationService(db, settings), principal,
    command => { dispatched.push(String(command.commandId)); }, () => true);
  for (const title of ["First", "Second"]) {
    const task = service.create(principal, { projectId: "project_schedule_online", title, prompt: `Run ${title}`, timezone: "UTC",
      schedule: { kind: "minutes", everyMinutes: 60, startsAt: new Date(Date.now() + 60_000).toISOString() } });
    db.run("UPDATE scheduled_tasks SET next_at=? WHERE task_id=?", new Date(Date.now() - 1000).toISOString(), String(task.id));
  }
  service.sweep();
  assert.equal(dispatched.length, 1, JSON.stringify(db.all("SELECT status,detail,session_id,command_id FROM scheduled_runs")));
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations WHERE project_id='project_schedule_online'")?.count, 1);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_runs WHERE status='pending'")?.count, 1);
  service.sweep();
  assert.equal(dispatched.length, 1);
  const first = db.get<{ run_id: string; command_id: string; session_id: string }>("SELECT run_id,command_id,session_id FROM scheduled_runs WHERE status='dispatching'")!;
  db.run("UPDATE command_projection SET state='unknown' WHERE command_id=?", first.command_id);
  db.run("UPDATE logical_sessions SET execution_state='unknown' WHERE logical_session_id=?", first.session_id);
  service.sweep();
  assert.equal(db.get<{ status: string }>("SELECT status FROM scheduled_runs WHERE run_id=?", first.run_id)?.status, "needs_attention");
  assert.equal(dispatched.length, 1, "uncertain work must never be sent twice");
  db.run("UPDATE command_projection SET state='applied' WHERE command_id=?", first.command_id);
  db.run("UPDATE logical_sessions SET execution_state='completed' WHERE logical_session_id=?", first.session_id);
  db.run("DELETE FROM project_turn_reservations WHERE command_id=?", first.command_id);
  service.sweep();
  assert.equal(db.get<{ status: string }>("SELECT status FROM scheduled_runs WHERE run_id=?", first.run_id)?.status, "succeeded");
});

test("long offline intervals coalesce to the latest occurrence without replaying a backlog", async t => {
  const settings = config();
  const { app, db } = await buildControlPlane(settings);
  await app.ready();
  t.after(async () => app.close());
  const workspace = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces LIMIT 1")!.workspace_id;
  const now = new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, "mach_long_offline", workspace, "spki_long_offline", "finger_long_offline", "Offline host", "linux", "1", "x64", now, now);
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, "project_long_offline", workspace, "mach_long_offline", "external_long_offline", "Project", "/tmp/long-offline", "identity_long_offline", now, now);
  const principal = new AuthService(db, settings).servicePrincipal("scheduled_long_test");
  const service = new ScheduledTasksService(db, new RegistryService(db, settings), new CoordinationService(db, settings), principal, () => {}, () => false);
  const start = new Date("2024-01-01T00:00:00Z").toISOString();
  const task = service.create(principal, { projectId: "project_long_offline", title: "Long interval", prompt: "Check", timezone: "UTC", schedule: { kind: "minutes", everyMinutes: 1, startsAt: new Date(Date.now() + 60_000).toISOString() } });
  db.run("UPDATE scheduled_tasks SET next_at=? WHERE task_id=?", start, String(task.id));
  service.sweep(new Date("2026-09-24T00:00:30Z"));
  assert.deepEqual(db.all<{ scheduled_at: string; status: string }>("SELECT scheduled_at,status FROM scheduled_runs WHERE task_id=?", String(task.id)).map(row => ({ ...row })), [{ scheduled_at: "2026-09-24T00:00:00.000Z", status: "pending" }]);
  assert.equal(db.get<{ next_at: string }>("SELECT next_at FROM scheduled_tasks WHERE task_id=?", String(task.id))?.next_at, "2026-09-24T00:01:00.000Z");
});
