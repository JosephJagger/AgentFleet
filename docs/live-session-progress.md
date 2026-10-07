# Live session progress

The panel reads progress while a turn is still running; the final answer remains a separate result. This does not require a new writer, a second `thread/resume`, or replaying a command.

## Native interface verified

Verified against the managed Codex CLI **0.160.1**, its `app-server --help` and generated protocol schema, plus the [official App Server documentation](https://developers.openai.com/codex/app-server).

AgentFleets launches `codex app-server --stdio` and exchanges newline-delimited JSON-RPC. It already receives `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `thread/status/changed`, and turn lifecycle notifications. We reuse that connection. The native server also advertises other transports, but this integration does not assume a native HTTP, SSE, or WebSocket progress endpoint.

`thread/read` and `thread/turns/list` provide read-only snapshots/history for outcome reconciliation. A snapshot is not a live subscription. `commands.reconcile` checks durable host command receipts and uncertain outcomes; it deliberately remains separate from progress and never re-executes the command.

## Delivery and presentation

1. The existing local Agent forwards native item/lifecycle notifications as durable events and text/output/diff updates as volatile frames over its authenticated AgentFleets transport.
2. The control plane validates host identity, producer/app-server epoch, session, project, active execution segment and native thread binding. Content-disabled projects cannot publish volatile content to browsers or the progress cache.
3. `GET /api/sessions/:id/progress` is authenticated, read-only and `Cache-Control: no-store`. It combines exact-turn durable events with a bounded in-memory volatile tail. Session detail includes the same projection.
4. The conversation shows **运行进度** while active. Expand **查看最近过程** for commands, file paths/diffs, model process messages, plan items and output snippets. The existing message timeline still receives pushed events. The compact progress view refreshes every two seconds in a visible tab and every ten seconds in a hidden tab, not a latency guarantee.
5. Panel coordinator task status includes `progress` scoped to that job's native turn. Explicit session queries also include `sessionProgress` for the current session turn, even when no coordinator job exists. An unbound job cannot borrow the current turn. Live progress does not automatically announce old task results over voice.

## Limits and failure semantics

- Only events emitted by Codex and forwarded for the attached session can be displayed. There is no synthetic completion percentage, ETA, raw private reasoning, arbitrary tool argument dump, or visibility into unrelated host processes.
- Native `turn/plan/updated` and file-change output deltas are not newly forwarded in this change; supported plan items and native file-change/diff events are displayed as available. A tool which emits no partial output may show only its start until its next native event.
- At most 120 recent durable events and eight displayed items are projected. Output/text tails are bounded. Volatile tails expire after two minutes, with at most 256 streams process-wide; they are not written to disk. A server restart or delayed page opening can lose partial output, while retained durable item/final events remain available.
- Authorization, content sync, deletion/expiry, content epochs, session/segment/turn isolation still apply. Turning off content sync hides content. Disconnected hosts show last-known progress, not a claim that the task stopped or completed.
- `turn.failed` and `turn.interrupted` are terminal alongside `turn.completed`; coordinator status must not keep waiting for a successful completion event. Progress is not proof of successful completion, and command submission is not proof a native turn started.
- Existing Agents already emit the required events. This patch changes control-plane/web code only, requires no Agent release or forced host restart, and does not add a database migration.
