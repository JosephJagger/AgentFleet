# Shared host and session navigation

All themes use `HostSessions` and the same host-selection policy. Theme choice
changes presentation, not which session opens or which choices are available.

- Selecting a host with one running session opens that session directly.
- With multiple running sessions, the last viewed session on that host is reused
  only if it is still running. Otherwise show the picker.
- Idle managed sessions are never automatically reopened from navigation memory.
- The picker keeps Codex and Claude Code groups, each with running and managed
  rows and explicit empty states. Missing Claude installation does not hide its
  group. Running sessions are not duplicated in the managed row.
- Selecting either kind of session collapses the picker. “切换会话” toggles it.
  “选择一个会话” toggles the project/session catalog instead.

Three independent forms of state must not be conflated:

1. Session history/detail and drafts retain their existing session/owner-scoped
   caching and recovery rules.
2. Per-host navigation memory in sessionStorage is owner/browser scoped and used
   only to choose between sessions that are still running.
3. Card selection highlighting is component-local, never persisted, and cleared
   when changing hosts or reloading. Background dashboard updates do not clear an
   explicit selection. Restoring a session URL does not restore this highlight.

The picker uses theme palette variables. Provider columns stack in narrow panes;
mobile conversation navigation wraps both the picker and inspector in the same
viewport so the switching entry stays accessible. Selecting a session only
navigates; it does not claim, rerun or dispatch work.
