# Voice-safe panel publication

The control plane owns live browser/host signaling sockets. Recreating this single container cannot migrate an existing WebRTC signaling session. Therefore publication is deferred until all existing calls naturally end. Host-side upgrade protection alone cannot protect a panel restart.

## Prepare first, switch last

1. Pull source, build a separate image (`agentfleet:prepared`) and run relevant tests. Do not change the running `agentfleet:local` tag or recreate the service yet. A backend-only build can use `packaging/Dockerfile.control-plane` with the currently verified image as `BASE_IMAGE` and a concrete `AGENTFLEET_BUILD_SHA`. Preserve immutable Agent artifacts; no Agent bump is needed for this feature.
2. Find the actual host path of the `agentfleet-data` Docker volume with `docker volume inspect`; use its `control-plane.sqlite`. This workflow requires Linux Docker/Compose and Python 3 on the deployment host.
3. Check and publish:

```sh
python3 packaging/deploy-control-plane.py --database /actual/volume/control-plane.sqlite --check
python3 packaging/deploy-control-plane.py --database /actual/volume/control-plane.sqlite \
  --image agentfleet:prepared --wait-seconds 60
```

The publisher pins the image digest, takes an OS publication lock, then atomically creates a durable admission fence. SQLite INSERT triggers block both panel/global and session voice starts, including starts from old browser pages or an older running backend. Existing heartbeats, tool requests, task reports and hangups remain unaffected. The new backend returns `VOICE_DEPLOYMENT_WAIT` with a user-readable explanation for a rejected start. Old backends during first rollout may show a generic connection error instead.

`starting`, `active`, `closing` and `unknown` calls all block publication. There is no age-based forced closure. If calls remain after the chosen timeout (default zero), exit **75** means deferred: no image switch/restart occurred and the fence is removed so new calls can start again. Retry the same prepared image later. Waiting never executes or replays historical tasks.

Once both call lists are empty, the script first keeps only the newest `--keep-backups` (default 5) pre-deploy backups of this database (exactly `<db>.predeploy-<32 hex>.sqlite` files and their `-wal`/`-shm` sidecars; nothing else is touched) and refuses to continue, before changing anything, if the volume lacks room for another copy plus 256 MB. A failed backup never leaves a partial file. Without this each publication left a full database copy and filled the disk. The script then backs up SQLite (mode 0600), switches only `control-plane` with `--no-deps --no-build`, and verifies readiness, expected build and guard support before reopening admission. Existing native project tasks continue on their hosts; ordinary panel/host sockets briefly reconnect at cutover. No browser refresh is forced. Publication does not update identity, proxy or validator services.

## First rollout and failure handling

The same SQL schema is shared by migration 52 and the Python publisher. First rollout adds only the guard table/triggers to the old database, without changing `user_version`; old code is fenced before the first container replacement. Schema 52 then adopts those objects. It never changes existing call states or task data.

A publisher killed mid-switch leaves the durable fence in place, deliberately without a timeout. Investigate readiness and container logs, repair the deployment, then explicitly reopen:

```sh
python3 packaging/deploy-control-plane.py --database /actual/volume/control-plane.sqlite --release
```

`--release` requires a healthy service and an exclusive publication lock. It does not restart anything. Do not remove a fence while a publisher still runs. Rollback is manual: older binaries may not understand migrated schemas; never blindly restore an old database over newer user writes. Backups contain the fence, so inspect/release it after any restore.

## Protection boundary

All normal backend and web container publications must use this entry point. Raw Docker restart/kill, host reboot, network outage, OOM, unrelated proxy shutdown and external deployment systems bypass it. It is not zero-downtime migration or automatic voice reconnection. Existing browser background/heartbeat/audio-error closure rules are unchanged. A stale/unknown call can defer deployment indefinitely and needs evidence-based lifecycle reconciliation, never forced deletion just to publish.

Tests: `python3 packaging/test-voice-deployment.py` and control-plane voice/deployment tests exercise old-binary fencing, simultaneous publishers, persistence after publisher loss, natural closure, timeout and ongoing-call tools.

## Browser signaling resume (global voice coordinator)

Between 10/2 and 10/16 the most common unwanted call ends were a dropped browser signaling WebSocket
(`SIGNAL_CLOSED`, 25 of 119 calls) and page leaves (`PAGE_LEFT`, 17). The audio runs over WebRTC and the host
keeps its own watchdog, so a short network blip need not end a call.

- A global call started with `resume: true` (`panel.start`) receives a secret `resume.token` and the hold window
  (`graceMs`, default 30 s; `panelResumeGraceMs` overrides it in tests). The call is held in a
  `PanelChannel` (`apps/control-plane/src/panel-signal.ts`), which behaves like the browser socket while it is
  connected.
- If the signaling socket closes without an explicit `stop`, the call stays `active` (so deployments still wait
  for it). Messages for the browser queue (400 at most; `answer`, `recovering`, `recovered`, `closed`, `error`
  are never dropped for ordinary ones). When the window expires without a resume the call ends as
  `SIGNAL_CLOSED`, exactly as before.
- The browser keeps microphone and WebRTC, retries within the window (a few seconds short of it) and sends
  `panel.resume {voiceId, resumeToken, diag}` on a new socket. The server accepts it only from the same
  authenticated client session that owns the call, with the current token (constant-time compare, rotated on every
  success, rate limited), then replies `resumed`, replays the queued messages in order and supersedes a half-open
  old socket (close code 4001). A rejected attempt never ends the call. An explicit `stop` (hangup, page leave)
  still ends it at once, and clients that did not ask for resume keep the old immediate behaviour.
- The call's `binding_json` gains `signalEvents` (last 8): drop (WebSocket close code, call age, whether it was
  held, host recovering), resumed (gap, replayed count, whitelisted client diagnostics such as `online`,
  `visibility`, network type, rtt, attempts) and `grace_expired`. Use them to tell a network drop from sleep or
  a throttled tab.
- While signaling is being re-established the voice status is "degraded" and the screensaver shows
  "网络波动，重连中…". A restart of the control plane still ends held calls (the deployment guard keeps that from
  happening during a publication).
- Refreshing or closing the page during a live call now asks for confirmation (`beforeunload`; the text is the
  browser's own). It still ends the call if you confirm.

### Automatic re-dial (global voice coordinator)

When a global call that had connected ends unexpectedly, `NativeVoicePanel` re-dials it by itself instead of
leaving the broadcaster on a dead call. "Unexpected" means: the signaling resume failed or its hold window
expired (`SIGNAL_CLOSED`), the audio connection failed (`AUDIO_DISCONNECTED`, `AUDIO_FAILED`), the host ended
the native session (`closed`), or the server reported a mid-call end (`error`).

- At most `MAX_AUTO_REDIALS` (2) in a row, after 2 s and 6 s. A re-dialled call that stays up for 60 s earns a
  fresh budget. A failed re-dial attempt (host busy, deployment wait) is retried within the same budget; when
  it is used up the error window opens as before.
- Never after anything the user did (hangup, leaving the page, logout, another call starting), a refused
  microphone, a call that never connected, or a session (non-global) call. Hanging up while a re-dial is
  pending cancels it.
- It is quiet: no window opens. The voice status carries `redial` (1..2), the call window (if opened) reads
  "通话意外中断，正在自动重拨（n/2）…", and a screensaver the call raised stays up and shows
  "自动重拨中（n/2）…". A re-dialled call is a new native call (new session context); dispatched tasks are
  unaffected.

## Background calls and browser lifecycle

The web client keeps microphone tracks, audio playback, WebRTC and signaling when
`visibilitychange` reports `hidden`. The global coordinator remains in the app
header outside view routing; minimizing either control panel only hides its UI.
Returning to `visible` sends a heartbeat on the existing started connection and
attempts audio playback again. A rejected autoplay attempt exposes the existing
manual playback button. It does not create a new call or replay tasks.

The existing 15-second client heartbeat, server protocol ping/pong and 120-second
owner/host watchdogs remain unchanged. Background timer throttling alone is not
used as a reason to stop a live connection; protocol pong can renew ownership.
There is no unbounded keepalive or automatic redispatch. Audio connection failures
still use the existing bounded disconnection handling.

`pagehide` means leaving the document (including back/forward-cache navigation)
and closes with `PAGE_LEFT`. Explicit logout uses `USER_LOGOUT`, another call
uses `OTHER_CALL_STARTED`, and component disposal uses `CLIENT_DISPOSED`.
Legacy `PAGE_HIDDEN` receipts remain readable for older clients. Do not use
`beforeunload` to stop audio: a navigation may still be cancelled. Socket loss and
watchdogs provide fallback cleanup when the browser cannot deliver `pagehide`.

This supports ordinary background tabs and window minimization, not guaranteed
capture through OS sleep, mobile app suspension, process eviction, page refresh
or closure. A resumed page whose call actually ended requires an explicit new
call. New frontend code takes effect on a later page load; never force-refresh
an existing call to apply this update. Publication still waits for all calls.

### Public release verification

The guarded publisher now reads the expected Agent version from the prepared
image and verifies the running service's `PUBLIC_ORIGIN` (or `--public-origin`)
after readiness. It compares installer bytes, manifest version, and all four
artifact sizes/SHA-256 values. A public verification failure is a failed release
gate, even if the panel is already healthy; it does not force rollback or keep
healthy voice admission fenced. Correct the download route and re-run the
read-only `packaging/verify-published-installers.mjs` check before reporting success.

Reverse proxies must forward mutable `/downloads/manifest.json`, `/install`,
`/install-macos`, and `/install.ps1` to the control plane rather than pinning
these paths to a past release directory. Preserve immutable versioned artifact
routes. Validate proxy configuration before a graceful reload, under the same
voice admission fence with both call counts zero; otherwise defer.

The authenticated `/api/agent-release-status` endpoint compares the public
manifest with the panel release metadata (30-second shared cache, five-second
fetch timeout). Host settings display source mismatches/unavailability separately
from host operation success. An `agent.update` result of `phase: current` means
only that the check offered no newer release; it is not a completed installation.
Previous health verification stays in dated update history. Equal installed and
running versions are shown once, and update targets only during active updates.

## Global voice host transport recovery (Agent 0.30.99)

A temporary host relay replacement does not by itself prove the dedicated global
voice process ended. Agent 0.30.99 suspends global tool admission and retains that
exact native call for a 60-second recovery window. Repeated socket attempts do not
extend the window. The existing native session voice behavior is unchanged.

The panel displays “正在恢复主机连接，核验原通话中（最多 60 秒）”. It retains the
browser microphone, WebRTC peer and authenticated signaling socket. After host
reconciliation, the control plane issues a fresh challenge bound to the current
transport generation. Recovery requires the original producer/app-server epochs,
per-call random instance ID, a still-live dedicated process with its original PID
and thread, and a still-authorized browser owner. Only then is the transport
binding advanced. There is no new SDP/start request, lease takeover, or replay of
voice task dispatches. Stale sockets and stale/duplicate challenge responses remain
fenced. Tool results interrupted in flight are unknown, not a reason to retry work;
query existing task status after recovery.

Timeout closes browser resources; native cleanup is swept every five seconds.
The panel checks its deadline on the ten-second maintenance sweep, so the error
notice can arrive shortly after the 60-second recovery window. Hangup, revoked
ownership, changed native epochs, or a confirmed absent process cannot resume.
An unconfirmed native writer remains `closing` and continues to block publication
until a live host confirms absence or acknowledges stop. Transport loss alone is
never used to clear that protection for recovery-capable calls. Recovery state is
held in memory while the durable call remains `active` (or `closing` for cleanup),
so the existing deployment admission guard continues to count it.

Both the new control plane and Agent 0.30.99 are required; old Agents cannot supply
continuity proof. Apply the Agent update only after the current call naturally
ends and start a new call from a refreshed panel. Browser signaling loss, browser
refresh/exit, OS suspension, or actual native audio/process termination are outside
this recovery boundary. Those still end the call and require an explicit new call.

Diagnostic logs record transport generation, numeric WebSocket close code and
whether the server superseded the connection; host logs additionally record the
WebSocket clean-close flag. They deliberately omit tickets and free-form native
error text. A reconnect alone does not identify a network fault.

## Voice reliability follow-up (Agent 0.30.100, schema 57)

New hosts advertise resume acknowledgement on the original SDP event. After a
same-process proof, the panel stays recovering until the exact resume nonce is
acknowledged on the new verified transport. The original 60-second deadline is
not extended; changed epochs, late receipts and hangup remain fenced. Agent
0.30.99 keeps its previous recovery protocol for compatibility. No replacement
call or dispatch is created. Apply the new host update after calls/tasks drain.

The host retains the last received user transcript snapshot while this native
process remains alive and repeats that snapshot, with a monotonic sequence,
after recovery. The server deduplicates it and stores only the latest user
utterance per call and freezes interrupted tails as drafts for seven days. New
speech after recovery cannot overwrite an unconfirmed draft. Disconnect/hangup
makes it available under
“待确认转写”. This is potentially incomplete, already-handled text, not an
executable instruction. An explicit review saves a pending todo only; execution
still requires a new explicit instruction and normal target/admission checks.
Associated dispatch/steer/save receipts block creating another pending copy.
Discard clears the text. No audio is recorded. Speech never delivered by the
native transcription service cannot be recovered. The optional Codex native
`flushTranscriptTailOnSessionEnd` remains false to avoid implicit handoff.

Web audio settings refer to the computer opening the panel, not the voice host.
Microphone selection applies to the next call; output selection uses browser
`setSinkId` when supported. Unavailable devices/permissions are shown rather
than silently selecting another microphone. A separate explicit local-only
microphone test and an input-level meter do not create a native call. Device
names may require microphone permission; unsupported output selection must use
OS settings. Preferences are stored in that browser. OS sleep, browser loss,
actual native process exit and audio disconnection are still outside host-relay
recovery. No Windows/macOS hardware compatibility claim follows from Linux
Chromium tests with synthetic audio.

The new database schema requires the prepared compatible backend; rollback must
follow the existing backup and voice-drain procedure, never replace a live
post-migration database with an older copy containing lost user writes.

### Refresh recovery hints

A refresh still destroys the old WebRTC call. On `pagehide`, a ready global call
writes only its host ID and timestamp to tab-local session storage. A reload
within five minutes offers **恢复语音** on the same host; it does not open the
microphone, replay tasks, or transfer the old call. The user starts a new call.
If that host is unavailable, no alternative is silently selected. Hints are
consumed once; ordinary navigation/back-forward and expired hints do not restore.

A connected local collector similarly saves its port on page exit. A reload
within five minutes attempts one loopback reconnection without opening an overlapping interaction
panel. Manual Stop/logout clears this intent. Failure uses the existing timeout
and manual retry; there is no reconnect loop. Automatic welcomes remain off and
pending events are not replayed. This does not preserve unsaved in-memory chat
or replay events that arrived while the webpage was absent. Browser microphone,
local-network, and audio-playback permissions still apply.

### Session composer during routine synchronization

A healthy connection can exchange a fresh registry snapshot without its transport
closing. The backend's existing `runtimeSyncUntil` identifies that same-connection,
same-runtime reconciliation window (at most 15 seconds); it is presentation evidence,
not write permission. The composer now distinguishes this from a disconnected host.
It performs bounded, non-overlapping read-only refreshes during that window so send
and append controls recover after authoritative reconciliation, even if no further
session event arrives. A hanging refresh cannot keep the healthy wording alive past
the deadline. Switching sessions or returning to live stops these reads.

The draft is retained; no message is queued locally, retried or automatically sent.
Normal running turns with append/queue controls no longer display the idle-send
fallback warning to check connectivity. This does not eliminate the backend's write
fence, repair event gaps, or change the host's update/restart policy.
