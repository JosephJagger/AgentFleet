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
  emitted. Type 6 can supply room metadata, but audience counts are never entry
  events. Other interaction types are not displayed.
- Candidates come from actual Companion packets with RoomId. Owner.UserId is
  optional upstream: `AttachRoomInfo` returns without an Owner on a cache miss.
  A bounded five-room, per-connection cache enriches subsequent packets only from
  matching room/broadcaster metadata. Type 101 also reads its nested RoomInfo.
  Conflicting owner IDs never merge. Stream start/end clears stale metadata.
- With broadcaster details, users compare the room and explicitly confirm it.
  Without those details, generate a random five-minute verification text, send it
  as ordinary chat in **their own** room, then confirm the matching candidate.
  Only an exact new chat match qualifies; entry text never does. This checks a
  message route for the user, **not official account ownership authentication**.
  Ownerless rooms can display chat/entry but cannot auto-welcome. Once owner
  details arrive they require confirmation again; no invented owner ID is sent.
  Missing RoomId or message IDs still rejects the packet. An alternate room,
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
   production demo events. If broadcaster details are missing, use the verification
   text flow; auto-welcome remains disabled until actual owner metadata arrives.
5. Connect the existing voice coordinator on this page (Agent 0.30.100+), verify
   its speech/playback events, and enable “入场自动欢迎”. Let a consenting viewer
   enter and send a separate chat message: only an eligible entry should trigger a welcome. Anonymous, missing-viewer-ID
   and broadcaster-self entries never trigger it.
   Verify Windows/Live Companion's actual audio capture includes the browser.

The panel CSP explicitly allows only `ws://127.0.0.1:*` in addition to its
existing same-origin connections. Browser HTTPS-to-loopback WebSocket and
local-network permission policies vary. Allow the browser's local-network prompt
on explicit Connect (or adjust this site permission if previously denied).
If blocked, this build reports a connection failure; it does not downgrade the
panel to HTTP or recommend disabling browser security. A secure local bridge may
be needed for such browsers and is not installed by this release.

## Evidence and verification boundary

Reviewed upstream sources (2026-10-12), repository main commit
`c9343da287cf77ce637c11e32333b2a511cd62e9` (2026-04-11):

- [Collector README](https://github.com/ape-byte/DouyinBarrageGrab/blob/c9343da287cf77ce637c11e32333b2a511cd62e9/README.md):
  Windows sources, configuration and capture limitations.
- [JSON models](https://github.com/ape-byte/DouyinBarrageGrab/blob/c9343da287cf77ce637c11e32333b2a511cd62e9/BarrageGrab/Modles/JsonEntity/BarrageMessages.cs):
  distinct Type 1/3, ProcessName, RoomId, Owner and MemberMessage fields.
- [WebSocket producer](https://github.com/ape-byte/DouyinBarrageGrab/blob/c9343da287cf77ce637c11e32333b2a511cd62e9/BarrageGrab/Server/WsBarrageServer.cs):
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

## Receive-path rewrite (2026-10-12)

Confirmed in code and upstream source, not inferred from the user's screenshot:

1. The previous parser silently rejected every chat/member packet lacking Owner.
   Upstream `AttachRoomInfo` explicitly permits this when its room cache is empty.
   The new parser preserves these events and keeps identity confirmation separate.
2. The old UI recorded only accepted event timestamps, making an idle socket,
   malformed JSON, wrong source process, unsupported interaction types and missing
   room/owner fields look identical. The UI now shows connection, received packet
   count/time, chat and separate-member counts, plus fixed rejection categories.
   Counts describe packets, not unique viewers or official live statistics; duplicates
   still count as received packets but appear only once in the message list.
3. Ownerless end packets could leave candidates behind because removal compared
   both room and owner. End now removes matching room candidates, buffered messages,
   selection and welcome eligibility regardless of absent owner fields.
4. Up to 100 chat/member events can be buffered before confirmation and displayed
   after matching room confirmation. Buffered entries are never replayed to voice.
   Stop/reconnect starts fresh reception/confirmation; welcome deduplication and
   cooldown survive a socket reconnect for the lifetime of this page.

Only explicitly marked Companion JSON packets are supported. Binary, unknown
schemas, other processes and unrelated interactions are counted with actionable
hints instead of being silently ignored. We intentionally do not guess legacy
field names or turn arbitrary browser-room traffic into the user's own room.
The panel sends **no collector commands** (proxy toggles, start/stop, hook changes,
installation or account operations). Reconnect is explicit and invalidates room
confirmation; it does not restart or reconfigure Companion or the collector.

If received packets stay zero while viewers chat, investigate the Windows collector
first: whether its own window receives chat/member messages, its version, process
and push filters, and whether it attached before the live message stream started.
Upstream documents that some builds cannot attach an already-established stream.
This is a candidate limitation, **not a confirmed explanation for this user's
machine**. Do not restart a running broadcast to diagnose it. Schedule any necessary
collector changes for a broadcast break. A local WebSocket success proves neither
capture nor room identity nor actual entry emission.

Validation: synthetic parser/component tests cover optional/cached owner data,
64-bit IDs, metadata conflicts/eviction/lifecycle, wrong processes and formats,
random-marker exact matches/expiry, ownerless manual confirmation, anonymous/self
entry voice exclusion, no buffered welcome replay and reconnect cleanup. Real
Chromium tests use a loopback fixture sender, never a production Douyin room.
Neither this Linux environment nor those fixtures verify the user's Windows
collector attachment, delivery of real Douyin chat/member events or audible native
welcomes. No current Windows sample/version has been provided for that last-mile
verification. Live Companion has not been restarted or modified.

Rewrite validation result: 608 web tests passed, 14 existing control-plane
welcome/recovery tests passed, and the production web build passed. Chromium
1280×720 and 1920×1080 checks exercised ownerless chat-marker confirmation,
separate entry display, missing-owner welcome disablement, cached-owner packets,
malformed-packet diagnostics and explicit reconnect without retained confirmation.
Fixtures were isolated and removed after testing. Production restart/publication
is deferred under the current instruction to protect the running broadcast/call.
