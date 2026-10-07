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
