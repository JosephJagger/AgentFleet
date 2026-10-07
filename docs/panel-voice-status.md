# Panel voice task status and maintenance

`agentfleets_panel` status queries with `sessionId` authorize that session and select only the current user's coordinator jobs for it. They never fall back to another session. An empty result explicitly says that the session has no coordinator-dispatched task; this is not a statement that all native work is idle.

Without `sessionId`, status and automatic polling are scoped to the current call. Old-call results remain accessible through an explicit session query. The one-outstanding-task dispatch guard remains workspace/user-wide, including tasks whose outcomes are unknown. Ending or reconnecting a call does not cancel or replay tasks.

Hosts already report `maintenance` in hello and heartbeat. Schema 49 stores that report. Explicit `null` clears the gate; legacy heartbeats that omit it preserve known evidence. Maintenance blocks new work in session capabilities, command admission, coordinator dispatch, and voice startup. Queued work waits without being removed. Cancellation, approvals and reads retain their existing permission checks. The host's own maintenance guard remains the final protection against races.

Task responses retain the existing fields and add `error`, `commandState`, `resultStatus` and `executionStarted`:

- `true`: a native turn is identified.
- `false`: the host explicitly rejected the task before execution with `MACHINE_DRAINING`.
- `null`: whether execution started is unconfirmed; do not retry automatically.

`historyLimited` is based on missing/deleted event payload evidence, not an empty result. A task rejected before execution has no generated result and is not described as having lost history. Errors remain attached to their exact command or native turn.

This release changes the control plane and web only. Existing Agents use the same tool schema and existing maintenance reports; no host restart or Agent artifact replacement is required to install the panel changes.
