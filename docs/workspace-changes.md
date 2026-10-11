# Turn workspace changes

Agent 0.30.93 captures an in-memory baseline before a panel-dispatched turn starts,
then samples every 15 seconds and before reporting completion. This supplements
native `fileChange` events with a separately labelled `workspace_snapshot` item.
The snapshot compares working file contents, not HEAD or the index: pre-existing
unchanged edits are excluded, and commits during the turn do not erase changes.
Concurrent external edits cannot be attributed to a writer and are explicitly
labelled as changes **during** the turn.

Sampling uses read-only `git ls-files --cached --others --exclude-standard` and
plain UTF-8 files inside the project root. It does not stage, checkout, reset,
commit or execute hooks. Ignored untracked files, symlinks, binary files, files
over 512 KiB and unreadable files are excluded. Bounds: 2,000 listed files,
16 MiB of baseline content, five-second Git and scan budgets, 30 changed files,
16,000 characters per diff. The panel marks partial results and further output
truncation. Unsupported Git projects get an explicit unavailable result.

Scope is the original project/session/execution segment/content epoch and native
turn. Content sharing off disables capture; disabling it during sampling prevents
publication. App Server exits and shutdown discard baselines. No history is
replayed, and a pre-upgrade or recovered turn without a baseline cannot be
retroactively reconstructed. Native voice-created turns without panel start and
standalone native-client tasks retain native-only change reporting. New code
requires a safely updated host Agent; a panel refresh alone is insufficient.

Baseline and sampling buffers are temporary process memory, not a Git index or
permanent file archive. Emitted bounded differences use existing authenticated,
retention-controlled event storage. This is a best-effort sampled observation,
not an atomic filesystem transaction; edits reverted between samples may be
absent in the final snapshot.
