# Composer command shortcuts

The `/` picker is a shortcut to the session's existing saved settings. It does not
maintain a second model or permission configuration. The send-settings summary and
the detailed settings editor read the same saved values.

- Type `/` or a prefix such as `/mo`. Click a command or use arrows and Tab/Enter.
- Model, reasoning effort and task-mode commands show choices above the input.
  Selecting a value saves immediately; `/model <reported-id>` also saves directly.
- Escape closes suggestions without changing the draft. Native task commands are
  completed into the draft and still require submission through their existing
  execution checks. Permission changes beyond the default require confirmation.
- `/help` lists commands in the same picker. Unsupported terminal commands are not
  presented as fully implemented web features.
- Errors retain the command draft. Saving never dispatches, queues or steers a task.
  Saved changes apply to future submissions; a running task keeps its configuration.
- Unsaved edits in the detailed settings editor must be saved or discarded first,
  so a shortcut cannot silently overwrite a pending edit.

## Provider scope

| Provider | Saved configuration shortcuts | Choices and persistence |
| --- | --- | --- |
| Codex | `model`, `effort`, `plan`, `fast`, `personality`, `summary` | Existing session runtime preferences and host model catalog; preserves unrelated overrides and session revision |
| Claude Code | `model`, `effort`, `plan`, `permissions` | Existing Claude session preferences; models, effort levels and approval modes reported by the host |
| Grok Build | `model`, `effort`, `plan`, `permissions` | Existing Grok session preferences; native task commands remain available from its reported catalog |
| Cursor | `model`, `effort`, `plan`, `fast` when reported, plus `permissions` | Existing Cursor session preferences; native option IDs and selected model's configuration options |

Other providers do not receive invented command catalogs or configuration values.
CLI model IDs and effort values stay native; UI labels follow the selected language.
Existing authentication, CSRF, revision checks and provider validation remain in
place. This is a web interaction change, not a replacement for every terminal UI.

## Claude planning and execution permissions

Plan mode is a stage, not a replacement for the chosen execution permission.
The host initializes Claude with the turn's selected permission, then awaits
native entry into plan mode before delivering any user input. A failed transition
closes the writer without sending the task.

`ExitPlanMode` is displayed as a request to **approve the plan and start
execution**, with the plan available for review. It is not labelled as a one-tool
approval. Declining keeps planning; viewing the plan does not submit a decision.
The web mapping also recognizes this request from older hosts.

Only an explicitly approved plan exit returns a session-scoped permission update
for the permission captured at turn start. It does not copy arbitrary native
permission suggestions, write persistent allow rules, approve other tools, or
adopt configuration edits made during the turn. Native permission checks still
apply. The execution permission remains visible as “After plan approval” while
the saved configuration selects plan mode.

This host fix requires an updated Agent package; deploying web assets alone only
clarifies consent and does not repair an already running native process. Follow
the existing idle-update protections rather than restarting an active session.

## Validation and delivery

Regression coverage includes partial completion, mouse/keyboard selection, direct
arguments, invalid arguments, save conflicts, approval confirmation, running-task
isolation, session switching, and configuration-store consistency. Browser checks
use an isolated fixture with the real session UI and styles, not live agent calls.
Ship web-only changes through the guarded control-plane publisher; they require
no Agent package or native CLI restart. The Claude permission handoff described
above additionally requires the host package update. Reloading an active voice
page still ends its browser media session, so refresh after finishing the call.
