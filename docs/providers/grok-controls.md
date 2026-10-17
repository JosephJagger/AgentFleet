# Grok controls and live output (Agent 0.30.117)

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
