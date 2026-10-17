# Additional native agents — phases 1 and 2

This branch adds Qwen Code, Kimi Code, Cursor, CodeBuddy Code and Grok Build. GitHub Copilot and the third-phase agents are excluded. Codex continues to use App Server and Claude Code continues to use its existing SDK adapter.

## Using the integration

1. Install and log in to the official CLI on the target host using the provider's instructions. AgentFleets does not install these CLIs or copy account credentials.
2. Run the updated connection service (Agent 0.30.109) and matching panel. Optional CLI discovery runs in the background, at most once per minute. A slow optional CLI does not block Codex/Claude catalog reads.
3. Choose the provider beside the host's project list. Unavailable or unverified runtimes remain disabled. Create a project/session or select an existing session when the CLI advertises session listing and restoration.
4. Send ordinary text. Native approval requests appear in the existing approval interface; only one-time approval is offered by this bridge. Cursor single-choice questions and plan approval use the existing interaction interface.
5. The Codex voice coordinator can search and dispatch to these providers through the same authorized directory/command path. Finding a session does not authorize execution. The target host does not acquire native voice capabilities from another provider.

All themes use the shared provider picker and session components. Native settings, accounts and permissions remain provider-specific. Codex models, plugins, images, slash commands and native voice controls are not applied to other providers. Native tool permissions follow the CLI's own configuration: the ACP adapter is identified as `native-acp-v1`, **not** as Codex's workspace sandbox. The panel explicitly displays this distinction.

## Capability and safety boundaries

- Existing native IDs are namespaced by provider. Codex and Claude IDs are unchanged. Database schema 61 expands the provider constraint while preserving project IDs, session references and indexes.
- `session/list` and `session/load` are negotiated. A CLI without listing can still create sessions in explicitly added projects; this does not imply that its older terminal conversations are discoverable. No private history format is guessed or rewritten.
- Only ordinary text with native defaults is supported in this iteration. Attachments, model overrides, plugins, structured output, goals, active-turn steering and deletion are rejected for the new providers, both in the panel and on the host.
- Concurrent restoration of the same native session shares one writer. Before restoring or starting a task, the adapter checks for other processes belonging to that provider. Without reliable per-session ownership, this is conservative: an external CLI for that provider can block panel writes even in a different directory. Panel-owned sessions in different projects may operate concurrently.
- Same-directory execution exclusion, login/CSRF validation, leases, command idempotency and stale-event fencing remain in the existing command path. Unsupported operations cannot fall through to Codex.
- Permission replies are bound to the exact request, action hash, session, turn and process epoch. Timeout/release cancels pending requests; no allow-always grant is selected. Unsupported multi-select or secret questions fail closed.
- Cancellation is a request until native completion arrives. A broken native connection, ambiguous prompt result or missing completion evidence does not become success and is never automatically replayed. Unknown tasks remain fenced; restoration of history alone is not evidence that a prior task completed.
- Native history snapshots are bounded (10,000 items / 16 MiB); catalog scans are bounded (20 pages). Historical turn boundaries or native usage absent from ACP are not invented. The existing history cursor handling preserves already synchronized content when native history is rewritten.
- Shared Agent process epochs still fence all adapters after a connection-service restart. This is not provider-independent restart recovery. A changed process/unknown task requires reconciliation, not retry.
- Host platform/credential checks are independent of Codex compatibility for the new adapters. A new provider's successful handshake never promotes Codex compatibility. Existing installers still retain their current Codex setup behavior.

## Validation and rollout status

Implemented and tested with synthetic JSON-RPC processes, synthetic databases and isolated UI data. No real host command, production database, account login, live conversation or voice call was used for testing. No new provider CLI is installed on the development host; **real authenticated execution and Windows/macOS native-provider certification remain unverified**. Handshake negotiation is not a claim that every version/platform of a provider works.

Tests cover all five provider identities, streaming and terminal ordering, restore, ownership refusal, concurrent restore, cancellation, dropped connections, timeout without replay, one-time permission, stale replies, Cursor question mapping, unsupported inputs, command idempotency, unsupported capabilities, independent host compatibility and schema migration. Legacy Codex/Claude and voice regressions are included in the full suites. The shared picker was checked in Chromium with four themes and a 390×640 viewport using synthetic data.

This is a development branch, not a production rollout. Before promotion, use an isolated host with an authenticated official CLI for each intended provider/platform. Verify an existing session, read-only task, explicit write approval, cancellation, reconnect and original-terminal ownership exclusion. Do not validate by dispatching to a live user project. Publish only through the guarded deployment workflow; do not restart live voice to activate this branch.

## Protocol references

- [Qwen Code's ACP bridge mappings](https://github.com/QwenLM/qwen-code/blob/main/docs/design/daemon-acp-http/README.md)
- [Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Cursor ACP, permissions and blocking extensions](https://cursor.com/docs/cli/acp)
- [CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp), [official CLI package and update behavior](https://www.codebuddy.ai/docs/cli/troubleshooting)
- [Grok headless/ACP entry point and no-auto-update option](https://docs.x.ai/build/cli/headless-scripting)

These references establish protocol entry points and documented behavior, not successful real-account testing in AgentFleets.
