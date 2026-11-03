# Dashboard directory occupancy prefetch

The dashboard already batched many session-ID reads after `79d700b`, and
`98c85ad` made each session's directory verdict lazy. Directory lookups still
queried project/machine IDs separately for many sessions. This change batches
those lookups for the current summary page.

## Scope and behavior

- The first eligible session on a page loads the page's physical directories and
  their reservations, running/uncertain sessions, and nonclosed voice sessions.
  Queries use chunks of at most 200 project IDs. Pages blocked before directory
  checks do not load this snapshot.
- Directory grouping preserves machine identity, Windows case/path normalization,
  POSIX case sensitivity, cross-provider aliases, and distinct worktrees.
- Each session still applies its own exclusion and own-active-voice exception.
  Existing availability priorities and returned session fields are unchanged.
- This snapshot exists only inside one synchronous summary-page read. Individual
  session reads and command admission retain their live checks. No native agent
  interaction, prompt, image context, execution, approval or task protocol changed.
- No migration, global cache, polling interval or response-field removal.

## Measurements

Read-only PostgreSQL diagnostics on the CVN-78 workspace used the actual compiled
RegistryService, without initializing migrations or acquiring a runtime lock.
A repeatable-read transaction compared the optimized dashboard with the old
per-session directory reader, including every returned field. CVN-78 pages for
Codex (30), Claude (8), Grok (6), and Cursor (2) matched individual session reads.

Six alternating warmed pairs, same database snapshot, service time only:

| Read | Original median | Prefetch median | Database calls before → after |
| --- | ---: | ---: | ---: |
| Dashboard | 435.5 ms | 298 ms | 215 → 74 |
| CVN-78 Codex page | 118.5 ms | 99 ms | 45 → 22 |
| CVN-78 Claude page | 68 ms | 69.5 ms | 29 → 22 |

These exclude HTTP, network transfer, compression, and browser rendering. Times
varied under concurrent load; the initial unpaired dashboard samples were
572–950 ms before and 442–488 ms after. They are not a browser latency guarantee.
The dashboard still returns repeated plugin catalogs; this change intentionally
preserves the response contract. Existing gzip delivery remains in place.

## Regression coverage

Run with `NODE_ENV=test` after building `apps/control-plane`. The 50-case suite passed on SQLite. PostgreSQL initially passed 48/50;
after correcting the two backend-version assertions described below, both failing
cases passed on recheck. The same suite runs
on SQLite and on an isolated PostgreSQL 18.6 instance using
`AGENTFLEET_TEST_PG_CONFIG` (never the production connection):

- directory-turn-lock, session-summary-performance, paginated-capabilities,
  read-batch, account-leases, control-plane, usage, worktrees.
- Added snapshot/live action equivalence for cross-provider aliases, Windows
  drive/UNC paths, Linux case, managed/native uncertainty, reservations and voice.
- Added chunk bounds, no per-session snapshot SQL, cross-host isolation, fresh
  reads on the next page, and unchanged live admission after a snapshot ages.

Two existing regression assertions incorrectly expected the SQLite version 73 on
PostgreSQL as well. They now use the frozen PostgreSQL baseline version for that
backend, so the command/usage behavior assertions actually run on both engines.

## Separate pre-existing migration finding

The additional `postgres.test` run exposes two failing offline-import tests:
`migrateSqliteToPostgres` requires the source PRAGMA version to equal the frozen
PostgreSQL baseline exactly, but newly created SQLite databases are now version
73. Both exact-import and NUL-rollback tests stop at that version guard. Neither
migration code nor those tests changed here. The PostgreSQL read-batch test passes.

This is not a failure of the live PostgreSQL read path, but the next SQLite to
PostgreSQL migration needs explicit baseline compatibility work. Do not alter
migration checksums or bypass the version check. The regression evidence must not
be described as a fully passing PostgreSQL suite.
