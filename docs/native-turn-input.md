# Native input during an active turn

Agent release 0.30.124, prepared 2026-10-18. Host connection service, control plane,
and web changes are required together. No new provider CLI is installed by this
change. Existing active writers are not cancelled, restarted or moved to a new
session. After a safe host-service update, new managed turns advertise capability;
an old connection service keeps its existing queue-only behavior.

## Provider behavior

- Claude: feed another UUID-tagged user message into the existing Agent SDK
  streaming input. Text and validated images are supported; attachment paths use
  the existing materialization flow. The host advertises `steerSupported` only
  for CLI versions with prompt-result attribution (>= 2.1.265). Continue consuming
  the same query until all accepted input UUIDs have results. A merged result or
  separate native results produce one Fleet turn completion. Interrupt/error still
  terminates the turn. Unsupported plugin/output-schema inputs are rejected.
- Grok: probe the registered `_x.ai/interject` handler using empty parameters
  (no session target). Only InvalidParams (-32602) proves the method exists.
  Send to the exact active native session with an interjection ID. Accept only a
  `queued` receipt, including the installed CLI's nested result envelope. This
  is Grok's native queue inside the running turn, not a Fleet next-turn job.
  Native code consumes it at a safe point; immediate interruption is not promised.
  Image interjection is enabled only for verified Grok 1.0.62 with image support;
  other versions can queue the complete image/text message instead. Unsupported
  attachments/goals/plugins/schema inputs are rejected, not silently dropped.
- Codex keeps its existing steering path. Other ACP providers remain queue-only
  until their own native input protocol has been verified.

Both creation and dispatch require host capability. Existing ownership, active
turn/version, authentication, CSRF, audit and command idempotency checks remain.
Known pre-input rejection does not freeze the task. Transport timeout or an
unrecognized native receipt remains an unknown outcome: do not automatically
retry, enqueue again or start a replacement turn. Native acceptance is not proof
that the model has already acted on the additional instruction.

## Evidence and validation

Official streaming interface: <https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>

Official Grok handler/actor contract:
<https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/interject.rs>

Isolated real-CLI checks on 2026-10-18, with temporary projects and no production
conversation touched:

- Claude 2.1.296 / Agent SDK 0.3.285: during a sleep tool, submit a second UUID.
  Final response included the added marker; native result attributed both UUIDs.
- Grok 1.0.62: during a sleep tool, interject an extra marker. Received nested
  `result.status=queued`, one original prompt completed and included the marker.
- Grok 1.0.62 image: interject a valid generated 128×128 red PNG. The same native
  prompt completed and identified the image as solid red. An earlier malformed
  tiny PNG was rejected by decoding and is not counted as a successful image test.

Automated tests cover exact-turn rejection, old-host denial, command deduplication,
Claude merged/separate input results, image payload, no extra ACP connection or
cancel/start, and frontend append versus next-turn queue. Chromium at 390×844
verifies both append buttons through an isolated API fixture; this is UI evidence,
not a production end-to-end deployment test. CLI versions other than the explicit
real checks above have not all been exercised live.
