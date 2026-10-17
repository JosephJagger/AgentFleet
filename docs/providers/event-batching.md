# Durable native event batching (Agent 0.30.116)

Large native completions could monopolize the local Agent event loop: each item
cloned and serialized the full SQLite state, while awaiting an already-resolved
write did not allow heartbeat timers or relay I/O to run.

ACP completion items and multi-item Claude messages now use batches of at most
32. The batch commits events, sequence allocation, deduplication receipts and the
history cursor together. Terminal turn events still follow the persisted items
and native writer handoff. Each batch yields to I/O; relay replay also yields
after 16 sends and rechecks the connection generation and acknowledgements.
These paths replay durable events, never execute a task again.

The local state cache uses a monotonic SQLite revision, read atomically with its
JSON row or returned by the current write. A trigger invalidates the cache for
older helpers that do not increment the revision themselves. Failed transactions
reload committed state. This is an additive local SQLite change; cloud schema
and native conversation files are unchanged.

Validation uses synthetic data: 1,000 completion items with a 10 MiB state payload
produce 32 transactions, allow a timer to run before completion, preserve event
order after reopening, and leave the command journal untouched. Separate tests
cover rollback, concurrent writers, old helper writes, ACP completion ordering,
relay replay and existing Codex/Claude lifecycle behavior. This does not claim
that all causes of host disconnects or control-plane latency have been eliminated.

Publish the panel and immutable Agent artifacts together. An auto-update-enabled
host prepares the new runtime and waits for tasks, approvals and voice to finish
before switching. A prepared download is not proof that the running worker has
changed. Never force a worker restart to bypass this boundary.
