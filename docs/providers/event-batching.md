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

## Control-plane catch-up

The server also needs to remain responsive while receiving a backlog. Schema 64
adds `durable_events_turn_idx(logical_session_id,native_turn_id,session_seq)`;
turn progress and result lookups no longer scan every event in a long session and
sort them. Event-triggered voice task projection refreshes the matching turn and
jobs whose turn has not yet been resolved. Late events for an older turn still
refresh that older job; events without a turn retain the previous session scope.
Authorization, event acknowledgement, retention and task execution are unchanged.

An isolated database-copy check of 60 result lookups reduced elapsed time from
1,617 ms to 21 ms with identical row counts. This is a diagnostic observation,
not a latency guarantee. Synthetic tests verify the selected query plan, schema
migration, matching/unbound jobs, and late historical results. A control-plane-only
publication preserves the already published Agent artifacts byte for byte.
