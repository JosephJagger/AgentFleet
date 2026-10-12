# Buzhoushan desktop: local Companion messages

The desktop Buzhoushan interaction window connects to HomeDouyinCollector on the
computer opening the webpage, not the selected remote Agent host. Default endpoint:
`ws://127.0.0.1:18888/`. The old collector path and room-confirmation workflow have
been removed. The panel never installs, starts, restarts or configures the collector
or Live Companion. Use this on the user's own broadcasting computer.

## Protocol and evidence

The new collector's source and stored implementation evidence were reviewed. It
reads appended Live Companion logs and emits JSON with `Type`, `ProcessName`, and
JSON-string `Data`. Accepted sources are `直播伴侣` / `直播伴侣.exe`, with
`Data.CollectorSource = companion-log`. Type 1 requires `WebcastChatMessage`;
Type 3 requires `WebcastMemberMessage` and `Action = 1`. Other member actions,
chat text, counts, gifts and likes never imply entry. `Owner` may be null.

Required fields include RoomId, MsgId, User.Id and an ISO ObservedAt timestamp.
64-bit numeric identifiers are preserved as strings. Events older than 20 seconds
or more than 5 seconds ahead are rejected. New service packets from all rooms are
accepted; room IDs namespace deduplication rather than select/filter a room.
Source labels are not authentication or proof of account ownership. This is an
unofficial local log collector, not an official Douyin authorization API.

The referenced Windows investigation reported genuine independent entry delivery
from Companion logs to its socket client. That historical evidence does not prove
current end-to-end panel receipt or audible welcomes. Ordinary chat extraction was
not established in that investigation: accepting the chat schema in the panel does
not make the collector produce missing chat events. No real Windows capture or
live audible welcome has been tested from this Linux deployment environment.

## Reception and welcome flow

Open “互动消息”, connect on the broadcasting computer, and inspect received packet,
chat and independent entry counts. There is no room-confirmation step. The panel
retains at most 100 messages in page memory; names and chat use the existing display
masking and text escaping. Closing the popup keeps reception; Stop, logout, page
exit and leaving the supported desktop theme stop reception. Reconnect clears the
message view and disables welcomes. No previous entries are replayed on enable.

Separately connect the global voice coordinator and enable “入场自动欢迎”.
Welcomes use the existing native voice call and its interruption behavior. No
WebRTC VAD/output-buffer events or fabricated audio-idle claim are required. A
connected call with available playback can request a welcome without first
speaking to the coordinator. Recovery or unavailable/blocked playback still
prevents requests. Native interruption is not a guarantee against overlapping
speech, and an interrupted welcome is never automatically restarted.

A fresh eligible entry follows this path:

`collector → panel validation/deduplication → authenticated global voice socket →
server priority/rate checks → thread/realtime/appendText → existing voice call`

The fixed instruction requests “嗨，你好，欢迎光临”. The transcript UI displays
conversation; it is not an input integration point. No new call, project task,
external TTS, chat text or viewer nickname is sent to the model. Rejection receipts identify protocol/time, duplicate/cooldown, task, recovery or
transport reasons instead of labeling every rejection as busy. Both collector and
browser timestamps allow up to five seconds of positive clock skew; the twenty
second expiry remains. Native acceptance
is not confirmed audible playback or a prerecorded exact-audio guarantee.

A viewer is welcomed at most once per ten minutes per room, with at least thirty
seconds between welcomes. Bursts merge into one pending entry, expiring after
twenty seconds. Deduplication and cooldown survive reconnect within the page.
Delivery is reserved before sending and unknown outcomes are never retried.
Running/unknown tasks and pending/failed task reports take priority.
The backend independently validates freshness, source/action, call ownership and
priority. Recovery/disconnection disables welcomes; an already accepted welcome
may still play. No audio cancellation or microphone interruption is performed.

## Browser and deployment limitations

Loopback is the only collector destination. Browser local-network permissions may
need explicit approval on Connect. Connection success proves socket access only;
diagnostics distinguish no packets, unsupported source/schema, stale packets and
accepted events. The service must bind to loopback. No browser security bypass or
remote collector URL is provided. Verify browser sound is included in the actual
Windows/Companion broadcast audio separately.

Automated fixtures cover ownerless new-service parsing, source/action/freshness
checks, large IDs, duplicate/multi-room events, independent entry versus chat,
connection failures/reconnect, welcome expiry and voice/task priority. Fixtures do
not constitute real Douyin capture or audible live verification.

Only web/control-plane assets change; immutable Agent 0.30.100 artifacts remain.
Publish a separately tested image via `packaging/deploy-control-plane.py`. Active
calls defer publication; never force a restart or refresh. Load the new page after
the current call ends. Collector and Companion require no restart for this release.
