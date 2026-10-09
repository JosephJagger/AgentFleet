# Session file delivery

Generated deliverables should be placed under the session project (for example,
`agentfleet-deliveries/`) and linked using their real paths. Keep explicitly
requested external originals; do not use symlinks to bypass project boundaries.
This convention is guidance, not a guarantee enforced on native clients.

For existing outside-project links, the panel reports the exact failure and offers
**Copy into project for delivery**. This is an explicit confirmed operation, not a
new model turn. It uses the existing Codex `command/exec` operation, control lease,
project/host idle checks, maintenance protection, permission profile, audit trail,
and command deduplication. Unknown results are never automatically resubmitted.

The initial implementation supports Codex on macOS/Linux with `python3` available.
It accepts common document/image/video/archive types, at most 50 MiB. It refuses
private credential paths, linked paths and non-regular/multiply-linked files.
It copies into a unique project directory without overwriting anything, checks
source size and timestamps after the copy, and retains the original. Copy failures
remove the incomplete destination file. An empty delivery directory can remain.

Confirmed successful receipts allow the original link to resolve to the copy,
strictly for the same user, workspace, session and source path. No other session is
searched. This mapping follows command-content retention; a removed/expired receipt
or deleted copy may require a fresh explicit delivery. The delivered file is a
snapshot, not a live synchronization of subsequent changes to the original.
Copies are project files and are not automatically deleted as attachment storage.

Downloads now show errors within the reply rather than opening raw JSON. Browser
previews use a conservative MIME allowlist; other formats download as attachments.
Browser transfers are bounded by the existing 50 MiB host limit. Preparation only
reveals a usable copy after the exact operation succeeds, and never starts a model
turn or executes historical task instructions.
