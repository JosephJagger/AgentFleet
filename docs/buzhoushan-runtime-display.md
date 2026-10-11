# Buzhoushan running heartbeat

The desktop heartbeat follows the active turn, not individual command or reasoning
item completion. A routine Agent registry refresh must not imply that execution
has stopped.

`LogicalSessionSummary.runtimeSyncUntil` is a presentation-only deadline. It is
issued after a valid hello only when the same connected transport, producer epoch
and App Server epoch were already healthy and online. During its pending
reconciliation, the Buzhoushan heartbeat remains green for at most 15 seconds.
Repeated pending snapshots retain the original deadline. The browser schedules
expiry even if no subsequent response arrives.

Initial connections, native restarts, malformed hellos, disconnected transports,
stale host heartbeats, degraded compatibility/security, read-only runtimes and
unknown task outcomes do not qualify. Control-plane restart loses the ephemeral
continuity hint. Session responses include fresh host connectivity so an older
dashboard snapshot cannot prolong an already resolved warning.

This changes presentation only. Reconciliation watermarks, replay grants, command
admission, queue dispatch, unknown-outcome recovery and connection timeouts retain
their existing rules. A green heartbeat during routine sync is not permission to
write or evidence that a native turn has completed.
