# Control plane

Node.js 24 and Fastify service with SQLite or PostgreSQL storage for browser authentication, host enrollment, session catalogs, command coordination, and synchronized history. Django verifies Resend email codes and manages users; this service issues revocable browser sessions and isolates workspaces. Host proof of possession uses Ed25519.

Use the root [self-hosting instructions](../../README.md) for deployment and configuration. The administrator is bootstrapped from your environment on first start. Verified sign-ins with the original email retain the existing workspace; new users receive independent workspaces. Do not publish environment files or database volumes.

The internal listener defaults to `127.0.0.1:3000`; Compose configures the container listener and publishes it on loopback. Readiness is available at `/ready` and `/healthz`. Configure HTTPS origins and exact trusted proxy peers before exposing a deployment.

For development, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in this directory. The service coordinates session ownership, queue reservations, idempotency, retention, and unknown-outcome recovery; changes require isolated integration tests and must not replay actions on real hosts.

## PostgreSQL rollout and rehearsal

PostgreSQL is opt-in through `DATABASE_URL` and `DATABASE_SCHEMA` (default `public`). An unset URL retains SQLite. Use a dedicated database and account; the account must own its application schema for initialization. The PostgreSQL baseline corresponds to SQLite schema 72 and is checked by version and checksum. Future changes require explicit PostgreSQL migrations; do not regenerate a shipped baseline to change existing databases. PostgreSQL 18.6 is the integration-test target.

The first implementation retains the existing **synchronous business-service contract**. `pg` runs on a worker with a dedicated connection; bounded synchronous calls preserve existing request ordering and `BEGIN IMMEDIATE` transaction semantics using a transaction advisory lock. This blocks the Node event loop while queries run, so PostgreSQL should be on the same host/network and latency must be measured before cutover. It does not provide asynchronous query concurrency or horizontal scaling. A session advisory lock rejects a second control-plane process for the same schema. Network failures poison the connection instead of retrying an uncertain write; restart through the supported operator workflow after diagnosing it.

`DATABASE_PATH` still identifies the local data directory for encryption keys and auxiliary files. Retain the existing data volume, particularly `writing-ai.key` and `ssh-access.key`. Changing the URL must never regenerate these keys. Local Agent state remains SQLite.

Create snapshots using SQLite's online backup API, including committed WAL pages. Do not copy a live `.sqlite` file. The existing `packaging.host_migration.snapshot_database` helper provides read-only snapshotting, integrity checks and a digest. The control-plane and Django snapshots are independent for rehearsal; final cutover needs both services' writers stopped before taking final snapshots.

The importer reads a snapshot without changing it, requires SQLite schema 72, and creates a **new, named PostgreSQL schema**. It refuses existing schemas, verifies every business table's count and ordered content digest, preserves referenced IDs, hidden row ordering and sequence high-water marks, and checks foreign keys before commit. Schema creation and data import roll back together on failure. Text is decoded strictly from the original bytes; invalid UTF-8 and NUL bytes are rejected. Planner statistics are collected before commit. Keep source snapshots and all keys for recovery.

Create a mode-0600 connection file containing `{"url":"postgresql://..."}` outside Git. From this directory:

```sh
npm run build
node scripts/migrate-postgres.mjs --snapshot /private/control-copy.sqlite \
  --connection-file /private/postgres.json --schema agentfleet_rehearsal \
  --report /private/preflight.json
node scripts/migrate-postgres.mjs --snapshot /private/control-copy.sqlite \
  --connection-file /private/postgres.json --schema agentfleet_rehearsal \
  --report /private/import.json --apply
AGENTFLEET_TEST_PG_CONFIG=/private/postgres-test.json npm run test:postgres
```

Use a separate test database for the last command. Tests create and remove a random schema per in-memory fixture; historical disk-backed migration tests still exercise SQLite. PostgreSQL import, rollback and connection-ownership tests require the environment variable and otherwise report skipped. No test should connect to real agents or send email. For a rehearsal of copied production records, bind only to loopback, disable external integrations and use a fake identity provider. Startup reconciliation intentionally updates the **copy's** transient machine/call state; retain the original verified snapshot separately.

`/ready` reports the database backend and identity as well as the deployment fence token. The canonical publisher supports PostgreSQL backups, publication locking and voice/SSH drain checks through `--postgres-config`; see [release provenance](../../docs/release-provenance.md). It deliberately rejects using a PostgreSQL publication config against a still-SQLite live service. Initial engine cutover also changes Django and requires a separately reviewed maintenance plan, final snapshots, restoration verification, and prevention of all SQLite writes. Do not switch by editing `.env` and running Compose. After PostgreSQL accepts new writes, restoring an old SQLite snapshot would lose those writes; recovery requires reconciliation or restoring the PostgreSQL backup.

### Rehearsal on 2026-10-26

An online SQLite backup of 1,003,098,112 bytes was imported into an isolated PostgreSQL 18.6 database: **88 business tables, 1,414,206 rows**, with every ordered content digest and row count matching. Strict UTF-8 preflight reproduced the same digests; the SQLite snapshot remained unchanged. The identity importer preserved all 24 application records across its four models. Neither production database was modified by the rehearsal.

The control-plane suite passed **430/430** with PostgreSQL fixtures (historical disk-backed SQLite migration tests remain SQLite). SQLite regression passed 427 with the three PostgreSQL-only tests skipped. Django passed 10 tests, including concurrent OTP consumption and resend races. Publisher checks passed 18 SQLite tests and 3 PostgreSQL tests; the existing host-migration suite passed 7 tests. Dependency lockfile validation and TypeScript compilation passed.

Copied data passed a real PostgreSQL Django-to-control-plane login using a mocked mail sender, preserving the original user and workspace. Reusing the OTP was rejected. History with actual conversation content, a 20-item session page and the scheduler API responded successfully; no commands were dispatched. Original local keys decrypted the migrated writing and SSH credentials. Voice tests cover ownership, signaling, interruption, resume and durable recovery using simulated peers; **live microphone/provider audio has not been accepted**.

Both PostgreSQL databases were dumped and restored into separate databases. All 90 control-plane tables (including the two PostgreSQL metadata tables) and all 10 identity tables matched their source content. These backups include rehearsal login/reconciliation writes, so their row counts differ from the initial SQLite import. The restored control plane also passed the application smoke checks.

Session summaries now prefetch bounded groups through PostgreSQL `LATERAL` reads and reuse prepared plans. Shared reads are cached only during one synchronous page; writes and rollbacks invalidate them. Project-scoped conflict reads use groups from the same project. Tests compare 40 summaries against individual reads, including quota totals, active writers, ownership and an expired lease. Copied-data checks also compare the complete 20- and 100-item responses with the original individual-query path.

Twenty-request diagnostic samples measured about **144 ms median / 196 ms maximum** for 20 items after batching, compared with 485 ms / 633 ms before batching and 93 ms / 115 ms on SQLite. For the frontend's actual 100-item request, the final sample measured **617 ms / 1,068 ms**, versus SQLite's **434 ms / 531 ms**; a previous PostgreSQL run reached 1,850 ms. The 100-item page used about 300 database-driver calls, including 99 batches. These are shared-host local samples, not capacity guarantees.

**Production cutover remains pending.** Database calls still block the event loop, and the larger page has a measurable latency regression. Agree on acceptable latency and test mixed session-list/voice traffic with live audio before scheduling the coordinated maintenance window. No production configuration, image or service was switched during this rehearsal.
