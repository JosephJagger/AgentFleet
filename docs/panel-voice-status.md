# Panel voice task status and maintenance

`agentfleets_panel` status queries with `sessionId` authorize that session and select only the current user's coordinator jobs for it. They never fall back to another session. An empty result explicitly says that the session has no coordinator-dispatched task; this is not a statement that all native work is idle.

Without `sessionId`, status and automatic polling are scoped to the current call. Old-call results remain accessible through an explicit session query. The outstanding-task dispatch guard is project-scoped, including tasks whose outcomes are unknown. Ending or reconnecting a call does not cancel or replay tasks.

Hosts already report `maintenance` in hello and heartbeat. Schema 49 stores that report. Explicit `null` clears the gate; legacy heartbeats that omit it preserve known evidence. Maintenance blocks new work in session capabilities, command admission, coordinator dispatch, and voice startup. Queued work waits without being removed. Cancellation, approvals and reads retain their existing permission checks. The host's own maintenance guard remains the final protection against races.

Task responses retain the existing fields and add `error`, `commandState`, `resultStatus` and `executionStarted`:

- `true`: a native turn is identified.
- `false`: the host explicitly rejected the task before execution with `MACHINE_DRAINING`.
- `null`: whether execution started is unconfirmed; do not retry automatically.

`historyLimited` is based on missing/deleted event payload evidence, not an empty result. A task rejected before execution has no generated result and is not described as having lost history. Errors remain attached to their exact command or native turn.

The initial status/maintenance fix changed the control plane and web only. Existing Agents use the same tool schema and existing maintenance reports; no host restart or Agent artifact replacement is required to install the panel changes.

## Parallel projects (Agent 0.30.86, schema 50)

The coordinator can dispatch tasks to different projects concurrently, on the same or different authorized hosts. Each tool call still names one target session. The workspace-wide single-task gate and per-user database uniqueness rule are replaced by a per-session unfinished-job constraint. Existing transactional project reservations remain authoritative: another session in the same project, an uncertain project operation, or a normal panel/native turn still blocks competing work. Host maintenance and permissions remain unchanged.

`status` accepts `jobId` for an exact task, optionally with a matching `sessionId`. A missing or mismatched task returns `PANEL_JOB_NOT_FOUND`, without fallback. Session-only queries keep their session scope; no target queries list the current call's tasks when there are multiple. Single-task responses retain their old top-level fields for compatibility. Results include stable project and machine identifiers as well as session, command and native turn identifiers.

Polling supplies a `tasks` array (all outstanding tasks plus up to 20 recent tasks) alongside the legacy representative `task`. The UI shows separate task cards and progress. An independent, oldest-first acknowledgement queue reports finished tasks even while other projects run; unreported completions are not lost because of the recent-history limit. Reconnecting does not automatically read out old-call results. Exact task/session queries remain available across calls to the authorized owner.

Retries with the same call/request identifier return the original job only when session and retained prompt match; changed targets/payloads are rejected. All dispatches still use the command journal, project reservation, lease, preconditions and atomic command/job transaction. No unknown outcome is automatically retried.

The voice host must run Agent **0.30.86 or later** and start a new call to load the updated native coordinator instructions and `jobId` tool schema. Older voice hosts retain their old single-task instructions; the panel explicitly indicates the update requirement. Target hosts need only the existing supported task protocol. Publishing this release does not force host restarts or bypass active-task/update drain protection.

## Persistent voice to-dos and results (Agent 0.30.87, schema 51)

Server-owned `panel_voice_todos` retain pending intent independently of the voice connection. `panel_voice_task_records` link each dispatched to-do to exactly one job and retain the original intent, dispatched prompt, host/project/session IDs, native turn, state, bounded result/error and acknowledgement. Existing jobs are backfilled from retained command content; unavailable intent is explicitly empty, never reconstructed or executed.

- `todo.save` saves a requested future/deferred task before the coordinator promises to remember it. No project/session is required until the target is known. A stable save key prevents duplicate inserts; conflicting reuse is rejected. Updates/cancellation require the current revision.
- `dispatch` with a to-do requires current user confirmation and matching revision. Previously linked to-dos return the original job, including across calls and after completion; they never create another command. A fresh retry after a failed task requires a new, explicitly authorized to-do. Legacy immediate dispatch remains compatible and records intent before admission; rejection leaves a pending to-do. Command, job and to-do link commit atomically.
- `recover` reads the current user's workspace records, including pending to-dos, outstanding jobs and terminal results without user acknowledgement. Reads are paginated with stable creation/id cursors. It is allowed during authenticated call startup, but mutations are not. The native coordinator obtains recovery data before creating its ephemeral thread; a five-second startup recovery timeout leaves voice available and explicitly does not imply an empty inbox.
- Recovery data is untrusted history, not user instructions. Loading it must not dispatch work, repeat an old task, automatically announce old results, or mark anything acknowledged. A recovered pending task needs a fresh explicit instruction. This feature does not authorize any historical backlog.
- Native lifecycle/item events update the durable record; a ten-second reconciliation loop also runs without active calls. Result projection follows the exact job/session/turn, and per-project reservations, same-session fencing, maintenance protections and cross-project concurrency remain unchanged.
- `reported_call_id` only proves delivery to the original voice transport. It is distinct from `acknowledged_at`: only an explicit user acknowledgement, through the UI or the coordinator's confirmed `acknowledge` action, removes a finished item from the recovery inbox. A user who heard a result but did not confirm it may still see it as unacknowledged.

Authenticated HTTP endpoints, usable without a call:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/voice-tasks?view=recover\|all&cursor=…` | Recover inbox or paginated history; no-store |
| GET | `/api/voice-tasks/:id` | Exact owned to-do and linked task |
| POST | `/api/voice-tasks` | Save `intent`, optional `sessionId`, stable `clientMutationId` |
| PATCH | `/api/voice-tasks/:id` | Change pending intent/target or cancel using `revision` |
| POST | `/api/voice-tasks/:id/acknowledge` | Mark a terminal result explicitly acknowledged |

Mutations use the existing authenticated, same-origin, CSRF-protected path. Records are scoped by both user and workspace; linked target permissions are rechecked before exposing results or dispatching. The UI under **语音总控 → 待办与结果记录** remains available after hanging up, with pending/all filters, pagination, cancel, target navigation and acknowledge actions. Opening the UI only reads records.

Limits: a task must actually reach `todo.save` (or a successful legacy dispatch admission path) to be remembered; audio lost before saving cannot be recovered from this ledger. We do not infer unsaved historical to-dos from conversation transcripts. Result text is bounded to 6,000 characters and respects source content retention, explicit deletion, content epochs and project content-sync settings. IDs/state remain when result text is unavailable. Recovery startup includes bounded summaries; the coordinator can query full records/pages. Only a voice host running 0.30.87+ loads the new save/recovery tools and instructions after a new call. No forced host restart or historical-task dispatch is performed by publication or migration.
