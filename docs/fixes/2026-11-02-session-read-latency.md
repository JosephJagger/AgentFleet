# Session and provider-switch read latency

## Evidence

On 2026-11-02 the user reported slow provider switching (Codex / Claude Code) on CVN-78 and slow session opening. A recent production HTTP log sample showed dashboard responses up to 5.4 s, session lists up to 4.8 s, detail up to 1.04 s, and history up to 216 ms. These mixed, small samples identify contention; they are not an end-to-end benchmark.

Read-only service profiling against the live PostgreSQL data identified repeated synchronous calls: one CVN-78 Codex session used 170 database driver calls for receipts and 102 for a 100-event history page. The frontend also requested a second global 100-session list despite the dashboard already returning recent and activity sessions, and waited for detail/approvals before beginning the initial history request.

## Changes

- Extend the existing request-local read batch scope to explicitly selected command IDs and event IDs. Reuse the same queries, mapping, ownership parameters and ordering. Batches remain bounded at 32; writes invalidate the cache and it never persists across requests.
- Apply batching only to receipt lists and paginated/incremental browser history. Use one retention cutoff timestamp per history page so batched query cache keys remain stable.
- Reuse and deduplicate the dashboard's recent and activity summaries instead of issuing another global 100-session request. Legacy responses without recent summaries keep the fallback. Project catalog pagination and remote search still fetch their own pages.
- Fetch initial history concurrently with detail and approvals. Discard a speculative history snapshot if its content/projection epochs disagree with the detail. Subsequent refreshes retain incremental history reads.

No changes to native Agent code, command dispatch, getCommand(), approvals, writer ownership, provider execution, model context or native conversation files. No database migration and no cross-request permission cache.

## Validation

- Control-plane build and web typecheck pass. 25 server and 127 web tests pass, including provider switching, session navigation, draft preservation, image/cleanup behavior, incremental history, cache isolation/invalidation, simultaneous initial reads and deletion epoch handling.
- Against live PostgreSQL using a separate connection with default_transaction_read_only enabled, sampled service-level measurements changed as follows: receipts 342 ms / 170 driver calls to 120 ms / 26 calls; history 196 ms / 102 calls to 40 ms / 6 calls. This excludes browser/network latency and was not measured by sending a task.
- In one read-only repeatable-read snapshot, compared the full batched and unbatched receipt/history results for five Codex and five Claude sessions on CVN-78: all 20 pairs were deeply equal. The audit connection performs no migrations, creates no schema, acquires no runtime ownership, and rejects writes.
- Profiling outputs remain in the task worktree's ignored output/read-latency directory.
