# Buzhoushan desktop: local live messages and voice welcomes

This feature is opt-in and mounted only in the desktop Buzhoushan theme. It reads
the computer **opening the web page**, not the selected Agent host. It does not
install a collector, change Windows proxy/certificates, obtain Douyin credentials,
or restart Live Companion. No public-room URL scraping is implemented.

## What is implemented

- “互动消息” opens a draggable window; minimizing keeps reception alive. Stop,
  logout, page exit, or leaving the desktop theme closes the local connection.
- Explicit connection to `ws://127.0.0.1:<port>/` (default 8888), with no remote
  endpoint, token, or arbitrary URL input. Connection alone is not proof of room
  identity or delivery. Last-event time and empty/waiting/error states are shown.
- DouyinBarrageGrab packets with source process `直播伴侣` or `直播伴侣.exe` only.
  Type 1 is chat; type 3 is a member/entry event. Chat text, counts, gifts, follows
  and likes never imply entry. Types 101/102 and 9 handle stream start/end when
  emitted. Other interaction types and audience statistics are not displayed.
- Candidates come from actual source packets with RoomId and Owner.UserId.
  Users must compare these with their own Live Companion account and explicitly
  confirm the room. This is user confirmation, **not official account ownership
  verification**. Missing room/owner data blocks reception. An alternate room,
  stream start/end, or collector reconnect requires confirmation again.
- 64-bit IDs are preserved as strings. Up to 5,000 recent packet keys are retained for deduplication for ten minutes; the view
  retains 100 messages, and all state stays in page memory. Names and chat are
  escaped text and pass through the existing display masking. None is sent to AI.
- Welcome is separately enabled after room confirmation and an active global
  voice call. New member events request exactly “嗨，你好，欢迎光临” using the
  existing native `thread/realtime/appendText` path; no synthetic browser TTS.
  Only bounded room/event/viewer IDs reach the authenticated voice socket.
- A viewer is eligible once per 10 minutes, all welcomes are at least 30 seconds
  apart, bursts merge into one pending request, and pending events expire after
  20 seconds. Delivery is reserved before sending and never automatically retried.
  The server independently bounds rate/deduplication and checks current owner,
  host transport, active call, and task/result state. No project task is created.
- Browser observes native WebRTC data-channel speech, response and output-buffer
  events. It requires input and output evidence and 5 seconds of quiet. A model
  `response.done` alone is **not** audio-playback completion. Missing activity
  events fail closed with a visible explanation. Talk to the coordinator once
  and wait for playback to finish before enabling welcomes.
- Running/unknown tasks, unreported task results, report failures and reconnects
  take priority. A recovery/disconnection turns welcomes off. Welcome failures
  are nonfatal to the call and never acknowledge a task result. Stopping reception
  stops new requests; a welcome already accepted by native voice may still play. The application
  never sends audio cancellation or mutes/stops the user's microphone for this.

## Windows setup and remaining conditions

1. On the broadcasting computer, independently review and run a compatible
   DouyinBarrageGrab build. It is an **unofficial collector**, not a Douyin
   authorization/API grant. We do not bundle its code or binaries.
2. Its documented settings include a local WebSocket port, process filtering and
   push filtering. Use Live Companion as the process source; include types
   `1,3,9,101,102` for chat, entry and lifecycle. Restrict listening to loopback.
   The upstream README and source differ on some listen settings, so verify the
   actual installed build's binding. Do not expose its unauthenticated socket.
3. Start/attach according to the collector's instructions during a suitable break.
   Some builds cannot capture a stream that was already established. Do not
   restart an active broadcast to apply this feature. Some metadata may only
   populate after the source has learned the broadcaster's room information.
4. Open desktop Buzhoushan on **that same Windows computer**, open “互动消息”,
   connect, then confirm the broadcaster/room from received events. There are no
   production demo events. With no collector or missing owner metadata it waits.
5. Connect the existing voice coordinator on this page (Agent 0.30.100+), verify
   its speech/playback events, and enable “入场自动欢迎”. Let a consenting viewer
   enter and send a separate chat message: only the entry should trigger a welcome.
   Verify Windows/Live Companion's actual audio capture includes the browser.

The panel CSP explicitly allows only `ws://127.0.0.1:*` in addition to its
existing same-origin connections. Browser HTTPS-to-loopback WebSocket and
local-network permission policies vary. Allow the browser's local-network prompt
on explicit Connect (or adjust this site permission if previously denied).
If blocked, this build reports a connection failure; it does not downgrade the
panel to HTTP or recommend disabling browser security. A secure local bridge may
be needed for such browsers and is not installed by this release.

## Evidence and verification boundary

Reviewed upstream sources (2026-10-12):

- [Collector README](https://github.com/ape-byte/DouyinBarrageGrab/blob/main/README.md):
  Windows sources, configuration and capture limitations.
- [JSON models](https://github.com/ape-byte/DouyinBarrageGrab/blob/main/BarrageGrab/Modles/JsonEntity/BarrageMessages.cs):
  distinct Type 1/3, ProcessName, RoomId, Owner and MemberMessage fields.
- [WebSocket producer](https://github.com/ape-byte/DouyinBarrageGrab/blob/main/BarrageGrab/Server/WsBarrageServer.cs):
  member handler, room metadata attachment, lifecycle packets, local WS broadcast.
- [Chrome local-network guidance](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/security/local-network-access.md):
  local-network permissions for public HTTPS pages connecting to loopback.
- [Official Realtime server events](https://developers.openai.com/api/reference/resources/realtime/server-events):
  VAD and output-buffer completion meanings. These API documents alone do not
  prove every Codex native version emits those events to the browser; missing
  evidence disables automatic welcomes.
- [Douyin official live interaction debugging](https://partner.open-douyin.com/docs/resource/zh-CN/live-interactive-tools/development/ide/live-debug/):
  developer/debug-account flow, not a general public local Companion API.

Automated fixtures validate parsing, 64-bit IDs, room confirmation, chat/entry
separation, duplicates, repeat entry, bursts, expiration, speech gating, native
report transport and nonfatal failure/recovery. They are synthetic test inputs,
not real Douyin entry verification. Isolated Chromium received fixture frames
from loopback under the production-style CSP on an intercepted HTTPS test origin
after granting the browser local-network permission; without permission it blocked
the request. The draggable UI was inspected at 1280 and 1920 pixels without
horizontal overflow. There has been no connected Windows collector,
official developer credential validation, real entry delivery or audible greeting
test in the deployment environment. Private protocol changes may break collection;
the collector cannot guarantee every real viewer entry is emitted. Receipt means
native text accepted, not audible playback. The exact wording is a native model
instruction, not a bit-for-bit prerecorded audio guarantee. Speech starting after
a welcome is accepted remains subject to native barge-in and timing; no absolute
zero-overlap claim is made.

## Publication

Only control-plane and web assets change; Agent artifacts stay immutable at
0.30.100 and there is no schema migration. Prepare/test a separate image, then
use `packaging/deploy-control-plane.py`. Existing calls must drain naturally;
timeout defers publication. After safe publication, load the new page when the
current call ends. No refresh, host update or broadcast restart is forced.
