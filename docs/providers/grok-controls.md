# Grok controls and live output (Agent 0.30.117)

> Updated implementation and remaining boundaries: [2026-10-27 ACP alignment](grok-acp-20261027.md). This document retains the original release evidence.

Grok sessions created on earlier Agents have no `configOptions` in their durable
receipts. Reading only those receipts left the model selector empty until another
turn finished. In addition, the adapter sent `value: {value: "…"}` to
`session/set_config_option`; Grok expects a string for these select options.

The Agent now reads `_meta.modelState.availableModels` during the existing native
initialize handshake. Discovery publishes only bounded model IDs, display names,
and per-model effort choices. It does not publish the other initialize metadata.
The server exposes this host catalog to existing and new Grok sessions, independently
of chat-body retention. Session-reported options remain a fallback. Model settings
are still per session, revision checked, authenticated and audited. Agent 117 or
newer is required for configured Grok turns; native session options are checked
again before sending a prompt. Unsupported choices fail rather than being silently
ignored. Model and effort changes apply on the next turn, never mid-task.

The settings read is independent of event frequency. New events trigger at most
one refresh per five seconds, with an idle catalog refresh every 30 seconds, without cancelling an in-flight read. Responses older
than an acknowledged save cannot overwrite it. Background read failure does not
clear already loaded settings. Model switches clear incompatible effort selections.

ACP intermediate replies complete when the stream changes to a tool or another
message type; reasoning snapshots are emitted at most every 250 ms and finalized
normally. Explicit native diff blocks map to file changes, and tool output retains
up to 64,000 characters instead of 4,000. Per-item size accounting avoids serializing
the entire retained conversation for every incoming chunk. Existing snapshot limits,
writer exclusion, cancellation, ordered completion, image validation and the
Agent 116 batching/yield protections remain in place. None of this replays failed
or unknown tasks, or removes approval requirements.

## Evidence and validation

On 2026-10-17 an isolated Grok 1.0.62 (`1474f9cbdd91`) process returned a model catalog
from initialize before any session or prompt. A temporary empty session rejected
the old object-valued setting with JSON-RPC -32602. String-valued model and effort
settings returned native confirmations of `grok-4.6` and `low`. No model prompt,
project edit or command execution was sent to a real user session. Available model
IDs are account/native-catalog dependent, not a hardcoded supported-model list.

Official source references:
- [initialize and ACP methods](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs)
- [select option validation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/handlers/config_option.rs)

Synthetic protocol tests cover exact string requests, rejected unsupported options,
active-turn exclusion, streaming text/thought/code before completion, cancellation,
ordering, images and all supported ACP providers. Server tests cover host discovery,
existing/draft sessions, authorization, revision conflicts and per-model efforts.
Browser tests cover continuous events and stale response races; an isolated browser
preview verifies model selection, incompatible-effort reset, and the settings dialog.
Long real-world Grok development tasks and future native versions still need field
validation; this change does not claim to eliminate every source of host latency.

Deploy the server/web and immutable Agent artifacts together through the guarded
publisher. Hosts prepare the update while busy and activate only after tasks,
approvals and voice allow it. A prepared artifact is not a running-version check.

## Usage, quota and native tool results (Agent 0.30.118)

Grok's `rawOutput` may be a nested native enum (for example `ReadFile.FileContent`),
while the standard ACP `content` carries the readable result. The adapter now falls
back to that readable content instead of dropping the output. Code and command
results use the existing process renderer; 不周山 keeps its separate execution pane.
Native `_x.ai/session_notification` retry, recovery and compaction notices are
mapped to bounded progress descriptions. They never complete a task, replay a
prompt or expose arbitrary native error strings.

Grok `_meta.usage` is cumulative only for the current native process. AgentFleet
releases and reopens native writers, so treating that value as a durable session
counter loses subsequent turns. On completion the adapter instead reads the
native, persisted `grok --no-auto-update usage <session-id>` ledger, with a three
second timeout and 4 MiB output bound. The session ID and latest turn timestamp
must match; partial/invalid/stale data is omitted, never replaced by zero. Native
cumulative totals and the latest complete turn feed the existing deduplicated
usage accounting. `cachedReadTokens` is mapped to cached input, already included
in input tokens. There is no reconstruction or backfill of pre-integration usage.
Large ledgers exceeding the bound, unsupported versions, failed native writes or
abrupt process loss can still leave a turn's usage unknown.

Quota is read using `_x.ai/billing` on an existing discovery connection, at most
once per two minutes (actual reporting depends on discovery/heartbeat timing).
Only the percentage, actual period and observation time are forwarded. The server
validates them again and keeps Grok separate from Codex/Claude. Missing/error
responses preserve the prior timestamped snapshot, marked stale after three
minutes. No credentials, monetary balances or billing history are published.
Identity is unknown, so different hosts' snapshots are not added together.
The UI polls stored data every 30 seconds; it does not initiate billing requests.

On 2026-10-18, installed Grok 1.0.62 returned real weekly quota through this ACP
extension. An isolated synthetic session read a temporary sample file through the
actual adapter and emitted its content as a durable process item. A second turn,
after releasing and reopening the native process, produced an exact cumulative
usage delta matching its latest-turn total. No existing user session was resumed
or prompted. Long development runs, other native versions and other operating
systems have not been live-tested by this verification.

Protocol/source evidence:
- [Native persisted usage ledger](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/usage_file.rs)
- [Usage CLI](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/usage_cmd.rs)
- [Billing extension](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs)
- [Usage and process notification types](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/notification.rs)
