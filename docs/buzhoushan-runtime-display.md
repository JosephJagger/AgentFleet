# Buzhoushan running heartbeat

The desktop heartbeat follows the active turn, not individual command or reasoning
item completion. A routine Agent registry refresh must not imply that execution
has stopped.

`LogicalSessionSummary.runtimeSyncUntil` is a presentation-only deadline. It is
issued after a valid hello only when the same connected transport, producer epoch
and App Server epoch were already healthy and online. During its pending
reconciliation, the Buzhoushan heartbeat turns gold and continues animating for at most 15 seconds,
with the label “正在同步状态”. Healthy execution outside synchronization is green.
Uncertain state uses a paused gray heartbeat labelled “运行状态待确认”.
Repeated pending snapshots retain the original deadline. The browser schedules
expiry even if no subsequent response arrives.

Initial connections, native restarts, malformed hellos, disconnected transports,
stale host heartbeats, degraded compatibility/security, read-only runtimes and
unknown task outcomes do not qualify. Control-plane restart loses the ephemeral
continuity hint. Session responses include fresh host connectivity so an older
dashboard snapshot cannot prolong an already resolved warning.

This changes presentation only. Reconciliation watermarks, replay grants, command
admission, queue dispatch, unknown-outcome recovery and connection timeouts retain
their existing rules. An animated gold heartbeat during routine sync is not permission to
write or evidence that a native turn has completed.
