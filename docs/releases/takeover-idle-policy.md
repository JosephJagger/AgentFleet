# Workspace takeover idle policy

Settings → Cloud history now includes a separate Session control card. The independent workspace policy defaults to 14 days and supports 3/7/14/21/28/30-day presets or any integer from 1 through 30. It applies to existing and future managed sessions across hosts, projects, providers and themes in that workspace. It does not change project content retention or native Codex configuration.

The idle clock uses the latest of recorded positive token usage, takeover/start events, and session creation. Reclaiming a session therefore resets the clock even when older token usage exists. A policy save affects subsequent hourly idle checks; it neither releases sessions immediately nor restores already released sessions. No new automatic reclaim behavior is added.

Expiration requests only the existing `thread.release` operation. It releases native writer ownership after host confirmation. It does not delete sessions or history, purge content, or issue native deletion commands. Existing online/compatibility/writability, idle-turn, approval, queue, uncertain-command and lease conditions remain. Nonclosed project voice sessions or workspace global voice calls also defer automatic release.

`GET/PUT /api/settings/takeover-policy` derives the workspace from the authenticated principal. Writes require CSRF, validate integer bounds and a revision, reject stale writes with HTTP 409, and append `takeover.policy.update` audit records. The UI preserves unsaved input on conflict and provides explicit reload. The policy has its own `takeover_policies` table (schema 59); no project retention columns are reused. An absent policy row yields 14 days, including for existing workspaces.

Validation uses isolated synthetic data, including policy persistence, authentication/CSRF, revision conflicts, independent scope, a recent takeover with old token usage, exact idle boundary, busy/offline/voice guards, non-deletion, and UI presets/custom input/conflict recovery. Browser preview covers desktop and narrow screen layouts.

Only the panel/server changes. Agent 0.30.103 and npm installer packages remain unchanged. Publication must use the guarded publisher with a prepared immutable image; an active or uncertain call defers publication. Schema 59 is additive, but the older schema-58 binary cannot reopen it: do not roll back by only retagging the old image.

Checks completed: 293 control-plane tests plus a passing additional policy/content-independence regression; 671 web tests covered (the missing translation entries were fixed and their check passed; one workspace timeout passed in a focused 76-test rerun); nine deployment guard tests; repository type checks and production build. No tests dispatch commands to real hosts. The policy and release tests use synthetic databases only.
