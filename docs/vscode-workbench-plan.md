# 不周山 — desktop workbench implementation plan

Status: implemented; validation and publication tracked in the delivery report.

Scope: a new theme named 不周山 (`buzhoushan`). Workbench layout and livestream controls apply only on desktop (viewport wider than 1100 CSS pixels). Existing themes remain unchanged; no mobile layout redesign.

## Purpose

Introduce an optional workbench theme inspired by VS Code Dark+. This is a layout variant, not only a palette. Make a selected session's task, real execution activity, and results legible during a livestream without changing task execution semantics. Preserve the existing themes and workflows.

## Workbench structure

- Compact top bar: selected host/project context, existing global navigation and voice access.
- Narrow activity rail: navigation backed by existing views, with accessible labels.
- Collapsible explorer: projects and sessions for the selected host. Preserve search and selection behavior.
- Main editor-like area: selected conversation, approval requests, and composer. These remain the primary interaction surface.
- Lower-right activity dock: actual code-change summaries, command execution, and available output for that session. It has a bounded height, separate scrolling, expand/collapse, and adjustable size.
- Slim blue status bar: actual host connection and session execution state. Do not interpret host online as task readiness.

Desktop arrangement:

```text
┌────────────────── context / navigation ──────────────────┐
│ activity │ explorer │ selected session                   │
│ rail     │          │ conversation and composer          │
│          │          ├────────────────────────────────────┤
│          │          │ code activity / command output     │
├─────────────────── actual status ────────────────────────┤
```

The dock must leave a usable conversation and composer area. Size constraints apply on small laptop displays. Narrow screens retain the existing conversation layout; desktop-only workbench controls do not mount.

## Interaction and livestream presentation

- A reversible “livestream focus” option reduces navigation and account metadata while retaining task context, activity, composer, and an obvious exit control.
- Clearly separate focus presentation from privacy: hiding navigation does not redact file paths, conversation text, terminal output, or source code.
- Command output is available on demand; an idle task shows its actual last known activity, not synthetic live animation.
- New events do not steal selection or force scroll when the user is reading older activity. Follow-latest is explicit, with a new-activity indicator when not following.
- Theme/layout changes preserve the selected session, draft, pending approvals, and voice lifecycle. Layout ownership must not remount the voice coordinator.
- Remember layout sizes and focus preference locally using namespaced keys. Clamp restored dimensions to the current viewport and provide a reset-layout action.
- Resize handles support pointer and keyboard input. All controls retain visible focus, labels, and reduced-motion behavior.

## Existing data and integration constraints

The current `RuntimeProgress` component polls `api.sessionProgress` while a native turn is active, at two seconds in the foreground and ten seconds when hidden. `SessionDetail` also supplies timeline events and optional progress. Reuse this authenticated data path. Do not add a second independent progress poller for the dock.

Before implementation, trace the complete progress ownership and subscription path. Extract a shared presentation/data hook or route the existing progress view into the dock so there is one source per selected session. Do not invent a Codex transport or initiate a native task to populate the view.

- Scope every update by session ID and active turn identity where available.
- Abort obsolete requests and reject late responses after selection changes.
- Keep live, stale, unavailable, content-disabled, and empty states distinct.
- Preserve suppressed/deleted content rules and existing permissions.
- Render genuine command text, available output, and file-change metadata. A full editable source buffer or live diff cannot be promised when the current event payload supplies only summaries.
- For providers without native progress support, show only available timeline evidence and label its limits.
- Bound retained/rendered activity and output; avoid duplicated large histories.

## Implementation stages

1. **Verify and establish boundaries:** inspect layout, theme initialization, progress lifecycle, mobile conversation mode, draft persistence, and voice ownership. Record baseline behavior and theme screenshots with synthetic fixtures.
2. **Workbench skeleton:** add the registered theme, first-paint palette, independent layout components/classes, desktop explorer and editor arrangement, responsive fallback, and status bar. Keep existing theme layouts unchanged.
3. **Real activity dock:** integrate the existing progress source, bounded event presentation, output details, freshness, empty states, follow-latest, and resize/collapse controls.
4. **Livestream polish:** add focus mode, restrained typography and spacing, local layout preferences, keyboard access, and reduced-motion support. Review whether the task and activity are legible at common streaming window sizes.
5. **Regression and delivery:** run the verification matrix, produce sanitized screenshots, build the web application, and use the existing voice-safe publication process. Report any deferred deployment accurately.

## Acceptance checks

- Existing themes retain their layouts and switch without a color flash or draft loss.
- The new theme is structurally different and the activity dock never blocks the composer or approval actions.
- Session A events cannot appear after switching to session B, including delayed responses.
- A running command/file change is shown before turn completion when the backend provides it; completed and stale activity is labeled correctly.
- No duplicate progress polling, task dispatch, or native history execution is introduced.
- Stream updates do not change the user's chosen scroll position unexpectedly.
- Desktop, small laptop, phone, browser zoom, resizing, keyboard navigation, and reduced-motion behavior remain usable.
- Focus mode and theme changes do not disconnect global or session voice calls.
- Publication uses `packaging/deploy-control-plane.py`; active calls defer affected deployment steps without forced restart or refresh.

## Explicit boundaries

This work does not implement a browser IDE, native file editor, terminal input, new task scheduler, or new provider protocol. Those would require separate behavior and security design. The first delivery presents existing, real execution information in a coherent workbench. Functional, readable layout takes priority over imitating every VS Code control.

## Delivered implementation

Theme ID: `buzhoushan`; display name: 不周山 / Buzhoushan. Select it in Settings → Appearance → Theme. Workbench layout is enabled above 1100 CSS pixels; narrower windows use the existing layout.

The activity dock replaces, rather than duplicates, the selected session's existing progress poller. It retains at most 60 display items and shows at most 16,000 output characters per selection. Native command/file-change progress is used when available; idle/provider fallback uses available, non-deleted timeline command/diff evidence. This is a viewer, not a source editor or interactive terminal.

The dock remembers height locally; focus mode remembers its local preference. Existing explorer collapse remains available. Stream focus hides navigation, explorer and account label without unmounting the conversation or voice controls. It does not redact conversation/output. Returning to other themes disables workbench layout.

Validation: frontend unit tests cover session/turn isolation, content-disabled and deleted payloads, in-flight polling and cancellation, inactive history, stable selection, resizing/collapse, and desktop-only activation. A synthetic browser fixture verified 1920×1080, 1600×1000, 1366×768 and 1280×720 layouts, focus exit, keyboard resizing and running-task navigation. At 390px the activity dock does not mount.
