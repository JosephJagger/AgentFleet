# Unified session recovery audit

The 0.30.162 recovery implementation covered only an obsolete runtime's bound
turn with no unresolved command receipts. Remaining dead ends identified:

- Unknown command receipts still use a separate, proof-only host button.
- Unknown sessions without a project reservation cannot recover.
- A stale projection in the current runtime is rejected before native activity is checked.
- Unbound reservations and failed claims cannot pass the old-turn-only gate.
- A reservation belonging to another session blocks a directory without identifying where to recover.
- Incompatible/read-only runtime support is incorrectly labeled as unknown task outcome.
- Duplicate retry after a failed recovery can reuse a terminal unsuccessful operation forever.
- Local orphan state can block automatic updates; a panel-only unlock does not repair the host.

Recovery must be an explicit user action with a scoped, durable host receipt. It
must preserve native identity and task content, never send a prompt, and reject
live execution, active voice, changed bindings and foreign ownership. Dismissed
unknown commands need durable replay tombstones, while their original unknown
outcome remains recorded. Missing original session files, offline machines and
incompatible runtimes are distinct conditions, not fictitious completed tasks.

## Implemented in Agent 0.30.163

- The banner and the session's More menu use the same user-triggered recovery API.
  The separate command-receipt recovery component is removed. A directory conflict
  links to the actual blocking session instead of making the user find it on SSH.
- The new host capability `sessionRecoveryRetry` handles current-runtime stale turns,
  unbound reservations, unknown command receipts, stale queue entries, and unknown
  sessions with no project reservation. Existing 0.30.162 hosts retain their limited
  recovery protocol until upgraded; unsupported cases clearly request an update.
- Recovery reads the original native session and requires it to be idle. The host
  rejects a changed directory/binding, active voice, in-flight command, native task
  still running, or concurrent runtime change. Another stale session in the same
  project is not a circular recovery dependency and is left unchanged.
- Host cleanup and its receipt are durable. The original command journal remains
  unchanged; a separate disposal marker prevents replay and removes its obsolete
  update/restart blocker. Native IDs, transcript, settings and message content stay
  intact. Pending approvals are invalidated rather than approved. Queued prompts
  are cancelled with their content retained, so recovery never implicitly sends them.
- The server accepts only the matching host receipt, connection epoch, content epoch,
  native binding, reservation, command snapshots and turn control version. New work
  fences an old response. A known terminal command outcome is preserved. UI receipts
  say the waiting state was cleared and keep the unknown original result explicit.
- Failed, expired and unsuccessful recovery attempts get a fresh token on the next
  click. Repeated successful requests are idempotent and cannot stop a newer workspace
  watcher. Late terminal events for a manually recovered turn cannot unsubscribe a
  newer turn. Item/message history is still imported.
- Runtime incompatibility is no longer mislabeled as a frozen task. Stop remains
  available for an actually bound current-runtime turn with uncertain bookkeeping.

## Boundaries

This does not disable execution identity checks or clear real native writers. An
unreachable host needs to reconnect; a deleted/missing original native session or
renamed/missing project still needs its actual source repaired or a new session.
The feature never manufactures a replacement native conversation. Internal automatic
receipt reconciliation is retained for truthful results, but is no longer a second
manual prerequisite for ordinary users.

## Validation

- Seven providers exercise the common server and host recovery paths: Codex, Claude
  Code, Cursor, Grok, Kimi, Qwen and CodeBuddy. These are protocol fixtures, not paid
  live model invocations.
- Tests cover persistence across reopen, prompt/history preservation, delayed replay,
  stale/current epochs, unbound/missing reservations, missing turn IDs, sibling stale
  sessions, changed bindings, native busy status, concurrent commands, fresh retries,
  queued work, real late receipts and fencing of newer turns.
- SQLite, isolated PostgreSQL schemas and frontend interaction/localization checks
  are run separately. No production task is replayed or recovered by these tests.
- First-message recovery resolves an original host binding even when its native ID
  did not reach the panel. If no native identity exists, it requires durable evidence
  that invocation never began. An invoked operation with a missing binding is not
  silently treated as unstarted; the UI asks for a host rescan.
