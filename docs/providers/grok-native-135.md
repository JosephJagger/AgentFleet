# Grok native workbench — candidate Agent 0.30.135

Status: implementation validated; publication preparation in progress. Not yet published or installed. The server also requires schema 66 and the matching web build. Old hosts cannot use `grok.manage`. No production database migration or service restart is part of this development verification.

## Verified contracts

Reviewed official [xai-org/grok-build](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8), source snapshot `559751fdcec02d413e4c57c8832ab275e4f44980`, alongside the installed Grok 1.0.62 user guide and isolated `initialize`/missing-argument probes. Wire extension names start with `_x.ai/`. Missing-argument probes establish handler recognition, **not successful authenticated execution**. No real user prompt, plugin installation, memory deletion, Git commit or worktree application was performed during development.

Contracts are independently allowlisted in the web, control plane and host; the browser cannot supply RPC names, session IDs or working directories as operation arguments. Exact contracts include snake-case `session_id` for memory flush/dream and MCP auth status, `filter_session_id` for input history, and snake-case `task_id`/`completed` in task snapshots. Subagent snapshots use camelCase. Do not normalize these by guessing.

## Stage 1 — session visibility and native controls

- Session configuration → **Grok 原生工具 / Grok native tools**: explicitly read running subagents, a selected child result, background tasks, input history and advertised commands. Stop only a task listed in this parent session; child results and cancellation validate parent identity.
- Native lifecycle notices for subagent start/finish, backgrounding, scheduler changes and goal status flow into the existing timeline. They are observations, not execution authorization or proof of foreground completion. Native task progress and outputs are bounded on-demand reads, not synthetic step counts.
- The composer suggests only native-advertised slash commands and fills text without sending it. Grok goals use the advertised native `/goal` command via the ordinary user-authorized turn path. Queue/interjection retain their original semantics; goal changes are not silently inserted into an active turn.
- Context window choices come from the selected native model and are verified before sending. X search supports native date bounds; UTC `toDate` is exclusive. The advertised `toolOverrides` capability flags are **not** search enable/disable settings.

## Stage 2 — session operations, memory, media

- Native rename, same-workspace fork, compact, checkpoint listing and scoped rewind (conversation, files, both). Rewind never sets native `force`; original panel audit history remains. A new fork is discovered on the next normal catalog scan; a fork receipt is not a newly claimed panel session.
- `/btw`-style side questions use the dedicated native method and a separately confirmed request.
- List, enable/disable, flush, dream and forget native memory. Memory is native host/account state and may affect other sessions. Deletion requires an exact listed non-generated file, complete UTF-8 preview ≤4,000 bytes, BLAKE3 hash, one-use preview within five minutes, and the native content-hash check. Larger/binary notes require the native client; no blind deletion.
- Native task starters for image/video generation, subagents, recurring work and code review append editable text to the existing composer draft. They never send automatically or invent RPCs; users complete the request and send through the ordinary task path.
- Inline image/video previews are opened explicitly. Local files use the existing authenticated session file endpoint. Storage previews require the configured workspace endpoint/bucket/prefix, fixed safe media types, unchanged ETag and ≤25 MiB. No model-supplied external URL is automatically loaded. SVG/HTML are not embedded.

## Stage 3 — extensibility and workspace operations

- Native skill, plugin, marketplace, hook and MCP connection/auth-status inspection. Explicit plugin install (HTTPS repository), enable/disable/update/uninstall/reload and hook enable/disable/reload. Pinned hooks cannot be changed. A marketplace read can synchronize Git caches and is treated as a mutation. Native multi-plugin uninstall confirmation is not bypassed.
- MCP required primitive form questions reuse explicit panel user input with type/range/enum validation, approval identity checks and cancellation on expiry/disconnect. Tool auto-approval does not answer these questions.
- Git status, bounded patch reads and literal project content search; native Git commit is staged-only with amend/push/sync disabled. This does not run `git add` or auto-publish code.
- Create a clean native Git worktree, list worktrees, inspect differences, and apply a registered worktree owned by the current native session back to its verified source project. Symlink/path drift and foreign ownership are rejected. Apply is always `merge`, never native default `overwrite`; native partial file application followed by conflicts is explicitly explained before confirmation.
- Startup rules, system-prompt override and named native profile are saved per session and applied only to `session/new`. Rules and override are mutually exclusive. Once a native ID exists these fields cannot be changed; resume/takeover does not overwrite native instructions.

## Deliberate limits / capabilities not claimed

- The reviewed ACP scheduler surface exposes deletion and notifications, **not a complete scheduler list/create API**. Native `/loop`, monitor and scheduling can still be requested in an ordinary user prompt, but this is not a fabricated structured scheduler management API. Panel schedules and Grok schedules remain separate.
- MCP URL/OAuth setup and optional/complex/secret forms are not exposed as completed browser authorization flows. Unsupported forms fail explicitly and require the native client. Auth status alone does not mean authorization succeeded.
- Native `x.ai/review/comment` records review comments; it is not an AI PR-review RPC. AI review, subagent creation/personas and image/video generation remain native tools requested through ordinary explicit prompts. No fictitious `/imagine` or PR-review method is synthesized.
- Plugin skills are discoverable/managed by Grok itself; this does not turn Codex-specific plugin attachments into Grok protocol inputs.
- No claim of a full subagent graph, arbitrary MCP schema editor, X search on/off switch or all native CLI functions. The three implementation stages cover the verified surface above; these interface limitations remain visible rather than silently falling back.
- Results: at most 100 rows / 24,000 display characters; old receipts show their timestamp. Large native outputs may be truncated; no automatic pagination or history execution is inferred.

## Concurrency, failure and deployment

Operations use existing login, workspace membership, CSRF, lease, exact execution segment/native identity/project version/active-turn preconditions and audit flow. Writes require explicit confirmation. Non-live mutations require panel host work and native parent background/subagent work to be idle; read requests do not fence other providers' new turns. Only task cancellation, subagent cancellation and side questions are live operations. Missing native handlers, invalid arguments and failed preflight reads are definite failures; mutation timeouts remain unknown and are never automatically replayed.

Schema 66 rebuilds only the command vocabulary table while preserving row IDs, referencing contents/projections and indexes, with foreign-key checks and reopen coverage. Rollback to a schema-65-only server after migration requires the normal database restore workflow; swapping only the server image is insufficient.

Publication requires the normal protected release workflow, new immutable 0.30.135 Agent artifacts and server/web deployment. Hosts adopt the update when safe; do not replace .134 artifacts, restart a busy host, or bypass active voice/drain protection. Saved configuration affects subsequent native turns, not already-running tasks.

## Validation evidence (2026-10-20)

- Control plane: complete serial suite **363 passed** (`/tmp/grok-cp-serial-final.log`). An earlier concurrent run produced an asynchronous `database is not open` error after a voice-recovery test ended. The targeted recovery/native-management rerun passed **44/44**, followed by the clean serial suite; this is not evidence that the unrelated teardown race has been fixed.
- Local Agent: **552 test cases covered, 542 passed and 10 skipped**, combining the ordinary suite with isolated replacements for environment-dependent fixtures. The ordinary run excluding process-scan tests had 539 passes, one runtime-ownership fixture failure and ten skips. That fixture launches the CLI as root, which redirects `--data-dir` to the fixed root directory. It was stopped and rerun under a separate non-root user namespace with auto-update disabled; the complete SQLite fixture group passed **12/12**. Process-scan fixtures ran in their own PID namespace and passed **2/2**, avoiding interference from real installed Cursor processes. Latest changed Grok protocol/form tests passed **66/66** (`/tmp/grok-local-lasttarget.log`). Do not run the root CLI ownership fixture against a live host without this isolation.
- Web: complete suite **819 passed** before the final task-starter and malformed-video-URL additions. Final affected component, settings, Markdown and translation tests passed **23/23** (`/tmp/grok-web-lasttarget.log`). The new entry points only fill drafts; malformed streamed media URLs cannot crash the conversation.
- All three TypeScript builds passed; web production assets built successfully. Vite still reports the existing large application chunk warning (~1.8 MB uncompressed); no warning suppression or unrelated bundle rewrite was added.
- Isolated browser inspection covered the real native settings/tools components at desktop and **390 × 844** mobile size; no horizontal overflow was observed. Screenshots are in `output/playwright/grok-native-135/`. The preview server and temporary harness were removed afterward. Task-starter buttons added afterward have component tests, but were not included in those screenshots.
- No authenticated model-generation, plugin install/uninstall, memory deletion, commit, worktree merge or real voice call was used as a live integration test. These use synthetic ACP peers plus reviewed native contracts; production account-dependent verification remains necessary.
- Initial development verification did not publish artifacts or migrate production. Publication preparation additionally fixed portable packaging of the new `@noble/hashes` dependency on all four platforms; the release must validate these archives before deployment. Final publication status is recorded below.
