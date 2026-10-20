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

## Validation and delivery

Regression coverage includes partial completion, mouse/keyboard selection, direct
arguments, invalid arguments, save conflicts, approval confirmation, running-task
isolation, session switching, and configuration-store consistency. Browser checks
use an isolated fixture with the real session UI and styles, not live agent calls.
Ship the web change through the guarded control-plane publisher; no Agent package
or native CLI restart is required. Reloading an active voice page still ends its
browser media session, so refresh after finishing the call.
