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

Once both call lists are empty, the script backs up SQLite (mode 0600), switches only `control-plane` with `--no-deps --no-build`, and verifies readiness, expected build and guard support before reopening admission. Existing native project tasks continue on their hosts; ordinary panel/host sockets briefly reconnect at cutover. No browser refresh is forced. Publication does not update identity, proxy or validator services.

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
