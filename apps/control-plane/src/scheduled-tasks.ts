import type { Principal } from "./auth.js";
import { AppError, invariant } from "./errors.js";
import { newId, nowIso } from "./crypto.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { RegistryService } from "./registry.js";
import type { CoordinationService } from "./coordination.js";

export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "minutes"; everyMinutes: number; startsAt: string }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] };

type TaskRow = {
  task_id: string; workspace_id: string; project_id: string; machine_id: string;
  owner_user_id: string; title: string; prompt: string; destination_kind: "existing" | "new";
  destination_session_id: string | null; schedule_kind: Schedule["kind"];
  schedule_json: string; timezone: string; next_at: string | null; enabled: number;
  created_at: string; updated_at: string;
};
type RunRow = {
  run_id: string; task_id: string; scheduled_at: string; status: string;
  session_id: string | null; command_id: string | null; detail: string | null;
  created_at: string; updated_at: string;
};
type TaskInput = { projectId: string; title: string; prompt: string; destinationSessionId?: string | null; schedule: Schedule; timezone: string };
type Dispatch = (command: Record<string, unknown>) => unknown;

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

export function validateSchedule(value: unknown, timezone: string): Schedule {
  invariant(typeof timezone === "string" && timezone.length <= 80 && validTimezone(timezone), 400, "INVALID_TIMEZONE", "Choose a valid time zone");
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), 400, "INVALID_SCHEDULE", "Schedule is required");
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === "once") {
    invariant(typeof schedule.at === "string" && Number.isFinite(Date.parse(schedule.at)) && /(?:Z|[+-]\d\d:\d\d)$/.test(schedule.at), 400, "INVALID_SCHEDULE", "Choose a date and time");
    return { kind: "once", at: new Date(schedule.at).toISOString() };
  }
  if (schedule.kind === "minutes") {
    invariant(Number.isSafeInteger(schedule.everyMinutes) && Number(schedule.everyMinutes) >= 1 && Number(schedule.everyMinutes) <= 10080, 400, "INVALID_SCHEDULE", "Minute interval must be between 1 and 10080");
    invariant(typeof schedule.startsAt === "string" && Number.isFinite(Date.parse(schedule.startsAt)) && /(?:Z|[+-]\d\d:\d\d)$/.test(schedule.startsAt), 400, "INVALID_SCHEDULE", "Choose a first run time");
    return { kind: "minutes", everyMinutes: Number(schedule.everyMinutes), startsAt: new Date(schedule.startsAt).toISOString() };
  }
  invariant(["daily", "weekdays", "weekly"].includes(String(schedule.kind)), 400, "INVALID_SCHEDULE", "Unknown schedule type");
  invariant(typeof schedule.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time), 400, "INVALID_SCHEDULE", "Choose a time in HH:mm format");
  if (schedule.kind === "weekly") {
    invariant(Array.isArray(schedule.weekdays) && schedule.weekdays.length >= 1 && schedule.weekdays.length <= 7 && schedule.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6), 400, "INVALID_SCHEDULE", "Choose one or more weekdays");
    return { kind: "weekly", time: schedule.time, weekdays: [...new Set(schedule.weekdays as number[])] };
  }
  return { kind: schedule.kind as "daily" | "weekdays", time: schedule.time };
}

export function nextOccurrence(schedule: Schedule, timezone: string, after: Date): string | null {
  const afterMs = after.getTime();
  if (schedule.kind === "once") return Date.parse(schedule.at) > afterMs ? schedule.at : null;
  if (schedule.kind === "minutes") {
    const start = Date.parse(schedule.startsAt);
    const step = schedule.everyMinutes * 60_000;
    return new Date(start > afterMs ? start : start + (Math.floor((afterMs - start) / step) + 1) * step).toISOString();
  }
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const afterParts = Object.fromEntries(formatter.formatToParts(after).map(part => [part.type, part.value]));
  const afterLocalDay = `${afterParts.year}-${afterParts.month}-${afterParts.day}`;
  const afterLocalTime = `${afterParts.hour}:${afterParts.minute}`;
  const start = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  for (let instant = start; instant <= start + 8 * 86_400_000; instant += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const localTime = `${parts.hour}:${parts.minute}`;
    const localDay = `${parts.year}-${parts.month}-${parts.day}`;
    if (localTime !== schedule.time || (localDay === afterLocalDay && afterLocalTime === schedule.time)) continue;
    const weekday = WEEKDAY[parts.weekday ?? ""] ?? -1;
    if (schedule.kind === "weekdays" && (weekday < 1 || weekday > 5)) continue;
    if (schedule.kind === "weekly" && !schedule.weekdays.includes(weekday)) continue;
    return new Date(instant).toISOString();
  }
  throw new Error("Could not calculate next scheduled occurrence");
}

function latestDueOccurrence(schedule: Schedule, timezone: string, first: string, now: Date): { latest: string; next: string | null } {
  if (schedule.kind === "once") return { latest: first, next: null };
  if (schedule.kind === "minutes") {
    const interval = schedule.everyMinutes * 60_000;
    const latestMs = Date.parse(first) + Math.floor((now.getTime() - Date.parse(first)) / interval) * interval;
    return { latest: new Date(latestMs).toISOString(), next: new Date(latestMs + interval).toISOString() };
  }
  // A daily or weekly rule has at least one occurrence in any eight-day window.
  // Skip years of missed occurrences without walking every old calendar day.
  const lookback = new Date(Math.max(Date.parse(first) - 1, now.getTime() - 8 * 86_400_000));
  let latest = first;
  let next = nextOccurrence(schedule, timezone, lookback);
  while (next && next <= now.toISOString()) {
    latest = next;
    next = nextOccurrence(schedule, timezone, new Date(next));
  }
  return { latest, next };
}

export class ScheduledTasksService {
  constructor(private db: ControlPlaneDatabase, private registry: RegistryService, private coordination: CoordinationService, private servicePrincipal: Principal, private dispatch: Dispatch, private ready: (machineId: string) => boolean) {}

  private task(principal: Principal, taskId: string): TaskRow {
    const task = this.db.get<TaskRow>("SELECT * FROM scheduled_tasks WHERE task_id=? AND workspace_id=? AND owner_user_id=?", taskId, principal.workspaceId, principal.userId);
    invariant(task, 404, "SCHEDULED_TASK_NOT_FOUND", "Scheduled task was not found");
    return task;
  }

  list(principal: Principal, projectId?: string): { tasks: Record<string, unknown>[] } {
    const rows = projectId
      ? this.db.all<TaskRow>("SELECT * FROM scheduled_tasks WHERE workspace_id=? AND owner_user_id=? AND project_id=? ORDER BY created_at DESC", principal.workspaceId, principal.userId, projectId)
      : this.db.all<TaskRow>("SELECT * FROM scheduled_tasks WHERE workspace_id=? AND owner_user_id=? ORDER BY created_at DESC", principal.workspaceId, principal.userId);
    return { tasks: rows.map(row => this.present(row)) };
  }

  get(principal: Principal, taskId: string): { task: Record<string, unknown>; runs: RunRow[] } {
    const task = this.task(principal, taskId);
    return { task: this.present(task), runs: this.db.all<RunRow>("SELECT * FROM scheduled_runs WHERE task_id=? ORDER BY scheduled_at DESC LIMIT 100", taskId) };
  }

  private present(row: TaskRow): Record<string, unknown> {
    return { id: row.task_id, projectId: row.project_id, machineId: row.machine_id, title: row.title, prompt: row.prompt,
      destinationKind: row.destination_kind, destinationSessionId: row.destination_session_id,
      schedule: JSON.parse(row.schedule_json), timezone: row.timezone, nextAt: row.next_at, enabled: row.enabled === 1,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  create(principal: Principal, input: TaskInput): Record<string, unknown> {
    const clean = this.validateInput(principal, input);
    const timestamp = nowIso();
    const nextAt = nextOccurrence(clean.schedule, clean.timezone, new Date(Date.now() - 1));
    invariant(nextAt, 400, "SCHEDULE_IN_PAST", "Scheduled time must be in the future");
    const taskId = newId("task");
    this.db.run(`INSERT INTO scheduled_tasks(task_id,workspace_id,project_id,machine_id,owner_user_id,service_client_session_id,title,prompt,destination_session_id,destination_kind,schedule_kind,schedule_json,timezone,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, taskId, principal.workspaceId, clean.projectId, clean.machineId, principal.userId, this.servicePrincipal.clientSessionId,
      clean.title, clean.prompt, clean.destinationSessionId ?? null, clean.destinationSessionId ? "existing" : "new", clean.schedule.kind, JSON.stringify(clean.schedule), clean.timezone, nextAt, timestamp, timestamp);
    this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, projectId: clean.projectId, action: "scheduled_task.create", metadata: { taskId } });
    return this.present(this.task(principal, taskId));
  }

  update(principal: Principal, taskId: string, input: TaskInput & { enabled: boolean }): Record<string, unknown> {
    const previous = this.task(principal, taskId);
    invariant(input.projectId === previous.project_id, 409, "SCHEDULE_PROJECT_IMMUTABLE", "Create a new scheduled task to use another project");
    const clean = this.validateInput(principal, input);
    invariant(typeof input.enabled === "boolean", 400, "INVALID_SCHEDULE", "enabled must be a boolean");
    const nextAt = input.enabled ? nextOccurrence(clean.schedule, clean.timezone, new Date(Date.now() - 1)) : null;
    invariant(!input.enabled || nextAt, 400, "SCHEDULE_IN_PAST", "Scheduled time must be in the future");
    this.db.run(`UPDATE scheduled_tasks SET project_id=?,machine_id=?,title=?,prompt=?,destination_session_id=?,destination_kind=?,schedule_kind=?,schedule_json=?,timezone=?,next_at=?,enabled=?,updated_at=? WHERE task_id=?`,
      clean.projectId, clean.machineId, clean.title, clean.prompt, clean.destinationSessionId ?? null, clean.destinationSessionId ? "existing" : "new", clean.schedule.kind, JSON.stringify(clean.schedule), clean.timezone, nextAt, input.enabled ? 1 : 0, nowIso(), taskId);
    this.db.run("DELETE FROM scheduled_runs WHERE task_id=? AND status='pending'", taskId);
    return this.present(this.task(principal, taskId));
  }

  setEnabled(principal: Principal, taskId: string, enabled: boolean): Record<string, unknown> {
    const task = this.task(principal, taskId);
    const nextAt = enabled ? nextOccurrence(JSON.parse(task.schedule_json) as Schedule, task.timezone, new Date(Date.now() - 1)) : null;
    invariant(!enabled || nextAt, 409, "SCHEDULE_COMPLETE", "One-time task has already passed");
    this.db.run("UPDATE scheduled_tasks SET enabled=?,next_at=?,updated_at=? WHERE task_id=?", enabled ? 1 : 0, nextAt, nowIso(), taskId);
    if (!enabled) this.db.run("DELETE FROM scheduled_runs WHERE task_id=? AND status='pending'", taskId);
    return this.present(this.task(principal, taskId));
  }

  remove(principal: Principal, taskId: string): void {
    this.task(principal, taskId);
    this.db.run("DELETE FROM scheduled_tasks WHERE task_id=?", taskId);
    this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, action: "scheduled_task.delete", metadata: { taskId } });
  }

  private validateInput(principal: Principal, input: TaskInput): TaskInput & { machineId: string } {
    invariant(typeof input.projectId === "string", 400, "INVALID_PROJECT", "Choose a project");
    const project = this.db.get<{ machine_id: string }>("SELECT machine_id FROM projects WHERE project_id=? AND workspace_id=?", input.projectId, principal.workspaceId);
    invariant(project, 404, "PROJECT_NOT_FOUND", "Project was not found");
    invariant(typeof input.title === "string" && input.title.trim().length > 0 && input.title.length <= 120, 400, "INVALID_TITLE", "Task title must be 1–120 characters");
    invariant(typeof input.prompt === "string" && input.prompt.trim().length > 0 && Buffer.byteLength(input.prompt) <= 200_000, 400, "INVALID_PROMPT", "Task prompt must be 1–200000 bytes");
    if (input.destinationSessionId) {
      const session = this.db.get<{ managed: number }>("SELECT managed FROM logical_sessions WHERE logical_session_id=? AND project_id=? AND workspace_id=?", input.destinationSessionId, input.projectId, principal.workspaceId);
      invariant(session?.managed === 1, 409, "SESSION_NOT_MANAGED", "Take over the selected session before scheduling it");
    }
    return { projectId: input.projectId, machineId: project.machine_id, title: input.title.trim(), prompt: input.prompt.trim(), destinationSessionId: input.destinationSessionId || null,
      schedule: validateSchedule(input.schedule, input.timezone), timezone: input.timezone };
  }

  notifications(principal: Principal): { notifications: Record<string, unknown>[]; unread: number } {
    const rows = this.db.all<{ notification_id: string; read_at: string | null; created_at: string; run_id: string; status: string; detail: string | null; session_id: string | null; title: string; project_id: string; machine_id: string }>(
      `SELECT n.notification_id,n.read_at,n.created_at,r.run_id,r.status,r.detail,r.session_id,t.title,t.project_id,t.machine_id
       FROM scheduled_notifications n JOIN scheduled_runs r ON r.run_id=n.run_id JOIN scheduled_tasks t ON t.task_id=r.task_id
       WHERE n.user_id=? AND t.workspace_id=? ORDER BY n.created_at DESC LIMIT 100`, principal.userId, principal.workspaceId);
    const unread = this.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM scheduled_notifications WHERE user_id=? AND read_at IS NULL", principal.userId)?.total ?? 0;
    return { notifications: rows.map(row => ({ id: row.notification_id, readAt: row.read_at, createdAt: row.created_at, runId: row.run_id, status: row.status, detail: row.detail, sessionId: row.session_id, title: row.title, projectId: row.project_id, machineId: row.machine_id })), unread };
  }

  readNotifications(principal: Principal, notificationId?: string): void {
    if (notificationId) this.db.run("UPDATE scheduled_notifications SET read_at=? WHERE notification_id=? AND user_id=? AND read_at IS NULL", nowIso(), notificationId, principal.userId);
    else this.db.run("UPDATE scheduled_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", nowIso(), principal.userId);
  }

  private finish(run: RunRow, status: "succeeded" | "failed" | "missed" | "needs_attention", detail?: string, notify = true): void {
    const now = nowIso();
    const updated = this.db.run("UPDATE scheduled_runs SET status=?,detail=?,updated_at=? WHERE run_id=? AND status NOT IN ('succeeded','failed','missed') AND status<>?", status, detail ?? null, now, run.run_id, status);
    const owner = this.db.get<{ owner_user_id: string }>("SELECT owner_user_id FROM scheduled_tasks WHERE task_id=?", run.task_id);
    if (owner && notify && Number(updated.changes) > 0) {
      this.db.run("INSERT OR IGNORE INTO scheduled_notifications(notification_id,run_id,user_id,created_at) VALUES(?,?,?,?)", newId("note"), run.run_id, owner.owner_user_id, now);
      this.db.run("UPDATE scheduled_notifications SET read_at=NULL WHERE run_id=? AND user_id=?", run.run_id, owner.owner_user_id);
    }
  }

  sweep(reference = new Date()): void {
    const now = reference.toISOString();
    const due = this.db.all<TaskRow>("SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_at IS NOT NULL AND next_at<=? ORDER BY next_at LIMIT 100", now);
    for (const task of due) this.db.transaction(() => {
      const current = this.db.get<TaskRow>("SELECT * FROM scheduled_tasks WHERE task_id=?", task.task_id);
      if (!current?.next_at || current.next_at > now || current.enabled !== 1) return;
      const schedule = JSON.parse(current.schedule_json) as Schedule;
      const { latest, next } = latestDueOccurrence(schedule, current.timezone, current.next_at, reference);
      this.db.run("UPDATE scheduled_tasks SET next_at=?,enabled=?,updated_at=? WHERE task_id=?", next, next ? 1 : 0, now, current.task_id);
      const oldPending = this.db.all<RunRow>("SELECT * FROM scheduled_runs WHERE task_id=? AND status='pending'", current.task_id);
      for (const old of oldPending) this.finish(old, "missed", "Superseded by a newer scheduled occurrence", false);
      const runId = newId("run");
      const expired = reference.getTime() - Date.parse(latest) > MAX_AGE_MS;
      const inserted = this.db.run("INSERT OR IGNORE INTO scheduled_runs(run_id,task_id,scheduled_at,status,detail,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", runId, current.task_id, latest, "pending", null, now, now);
      if (expired && Number(inserted.changes) > 0) this.finish({ run_id: runId, task_id: current.task_id, scheduled_at: latest, status: "pending", session_id: null, command_id: null, detail: null, created_at: now, updated_at: now }, "missed", "Scheduled occurrence expired after 24 hours");
    });
    const runs = this.db.all<RunRow>("SELECT * FROM scheduled_runs WHERE status IN ('pending','dispatching','running') OR (status='needs_attention' AND command_id IS NOT NULL) ORDER BY CASE WHEN status='needs_attention' THEN 1 ELSE 0 END, scheduled_at LIMIT 200");
    for (const run of runs) {
      const task = this.db.get<TaskRow>("SELECT * FROM scheduled_tasks WHERE task_id=?", run.task_id);
      if (!task) continue;
      if (run.status !== "pending") { this.reconcileRun(run); continue; }
      if (reference.getTime() - Date.parse(run.scheduled_at) > MAX_AGE_MS) { this.finish(run, "missed", "Scheduled occurrence expired after 24 hours"); continue; }
      const owner = this.db.get<{ disabled_at: string | null }>("SELECT disabled_at FROM users WHERE user_id=?", task.owner_user_id);
      if (!owner || owner.disabled_at) { this.finish(run, "needs_attention", "Task owner is unavailable"); continue; }
      if (!this.ready(task.machine_id)) continue;
      if (this.db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?", task.project_id)) continue;
      if (this.db.get("SELECT 1 FROM scheduled_runs r JOIN scheduled_tasks t ON t.task_id=r.task_id WHERE t.project_id=? AND r.run_id<>? AND r.status IN ('dispatching','running')", task.project_id, run.run_id)) continue;
      try { this.dispatchRun(run, task); }
      catch (error) {
        if (error instanceof AppError && ["PROJECT_TURN_RESERVED", "CONTROL_LEASE_HELD", "SESSION_RECONCILING", "MACHINE_OFFLINE", "TURN_ALREADY_ACTIVE"].includes(error.code)) continue;
        this.finish(run, "needs_attention", error instanceof Error ? error.message : "Could not start scheduled task");
      }
    }
  }

  private dispatchRun(run: RunRow, task: TaskRow): void {
    const principal = this.servicePrincipal;
    let sessionId = run.session_id;
    if (!sessionId && task.destination_kind === "existing") sessionId = task.destination_session_id;
    if (!sessionId && task.destination_kind === "new") {
      const session = this.registry.createSession(principal, task.machine_id, task.project_id, `定时 · ${task.title}`, `schedule-${run.run_id}`);
      sessionId = session.logicalSessionId;
    }
    invariant(sessionId, 409, "SESSION_NOT_FOUND", "Scheduled session is unavailable");
    this.db.run("UPDATE scheduled_runs SET session_id=?,updated_at=? WHERE run_id=?", sessionId, nowIso(), run.run_id);
    const state = this.db.get<{ managed: number; execution_state: string; reachability: string; active_turn_id: string | null; thread_control_version: number; project_id: string; lease_version: number; execution_segment_id: string }>(
      `SELECT s.managed,s.execution_state,s.reachability,s.active_turn_id,s.thread_control_version,s.project_id,p.lease_version,e.execution_segment_id
       FROM logical_sessions s JOIN projects p ON p.project_id=s.project_id JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL WHERE s.logical_session_id=?`, sessionId);
    invariant(state && state.project_id === task.project_id && state.managed === 1, 409, "SESSION_NOT_MANAGED", "Selected session is no longer managed");
    if (state.active_turn_id || !["idle", "completed", "failed", "interrupted"].includes(state.execution_state)) return;
    if (state.reachability !== "live") return;
    const lease = this.coordination.acquireLease(principal, sessionId);
    try {
      const result = this.coordination.createCommand(principal, sessionId, {
        clientMutationId: `scheduled-${run.run_id}`, type: "turn.start", controlLeaseId: lease.leaseId,
        precondition: { executionSegmentId: state.execution_segment_id, threadControlVersion: state.thread_control_version, expectedActiveTurnId: null, projectLeaseVersion: state.lease_version },
        payload: { prompt: task.prompt },
      });
      this.db.run("UPDATE scheduled_runs SET command_id=?,status='dispatching',updated_at=? WHERE run_id=?", String(result.command.commandId), nowIso(), run.run_id);
      this.dispatch(result.command);
    } finally {
      try { this.coordination.releaseLease(principal, sessionId, lease.leaseId, lease.version); } catch { /* Accepted command remains authoritative. */ }
    }
  }

  private reconcileRun(run: RunRow): void {
    if (!run.command_id || !run.session_id) { this.finish(run, "needs_attention", "Scheduled dispatch lost its command reference"); return; }
    const row = this.db.get<{ state: string; execution_state: string; active_turn_id: string | null; reservation: string | null }>(
      `SELECT cp.state,s.execution_state,s.active_turn_id,r.command_id AS reservation FROM command_projection cp JOIN commands c ON c.command_id=cp.command_id
       JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id LEFT JOIN project_turn_reservations r ON r.command_id=c.command_id WHERE c.command_id=?`, run.command_id);
    if (!row) { this.finish(run, "needs_attention", "Scheduled command is unavailable"); return; }
    if (["rejected", "expired", "invalidated"].includes(row.state)) { this.finish(run, "failed", `Command ${row.state}`); return; }
    if (row.state === "unknown" || row.execution_state === "unknown") { this.finish(run, "needs_attention", "Command result is uncertain; verify the host before continuing"); return; }
    if (row.state === "applied" && !row.active_turn_id && !row.reservation && ["completed", "failed", "interrupted"].includes(row.execution_state)) {
      this.finish(run, row.execution_state === "completed" ? "succeeded" : "failed", row.execution_state);
      return;
    }
    if (row.state === "applied" && run.status === "dispatching") this.db.run("UPDATE scheduled_runs SET status='running',updated_at=? WHERE run_id=?", nowIso(), run.run_id);
  }
}
