# Buzhoushan desktop: local Companion messages

The desktop Buzhoushan interaction window connects to HomeDouyinCollector on the
computer opening the webpage, not the selected remote Agent host. Default endpoint:
`ws://127.0.0.1:18888/`. The old collector path and room-confirmation workflow have
been removed. The panel never installs, starts, restarts or configures the collector
or Live Companion. Use this on the user's own broadcasting computer.

## Protocol and evidence

The collector source and its implementation reports were reviewed. It emits JSON
with `Type`, `ProcessName`, and JSON-string `Data`. The original log source uses
`直播伴侣` / `直播伴侣.exe` and `Data.CollectorSource = companion-log`.
Type 1 requires `WebcastChatMessage`;
Type 3 requires `WebcastMemberMessage` and `Action = 1`. The message view also
accepts Type 2 (`WebcastLikeMessage`), 4/8 (`WebcastSocialMessage`, follow/share),
5 (`WebcastGiftMessage`) and 7 (`WebcastFansclubMessage`). These mappings follow
the stored collector envelope models; real delivery from the current Home build
must still be checked. Other member actions, chat, gifts and likes never imply entry. `Owner` may be null.

Additional sources are accepted explicitly for display, based on HomeDouyinCollector
`feature/isolated-browser-source` commit `312f43d` (0.3.0):

| CollectorSource | ProcessName | CollectorTransport | Display scope |
| --- | --- | --- | --- |
| companion-log | 直播伴侣 / 直播伴侣.exe | legacy optional field | existing chat, entry and interaction types |
| companion-memory-bridge | 直播伴侣 / 直播伴侣.exe | native-publish-message | Type 1 / WebcastChatMessage only |
| douyin-browser-network | HomeDouyinBrowser | websocket / http-fetch | chat and interactions, never entry |

Process/source/transport combinations and native methods must match. The original
source remains on the parsed event; neither new source qualifies for automatic
welcomes. All sources retain room/message IDs, timestamps and cross-source event
deduplication. These source labels are compatibility checks, not authentication.
The collector's 0.3.0 report records a real bridged chat sent from Home and rejected
by the prior panel allowlist. This panel fix is tested with synthetic envelopes;
actual post-update display still needs a new Home message (no historical replay).
The attached partial conversation discusses capture rendering, not this protocol;
the protocol evidence comes from the collector branch source and documentation.

Required fields include RoomId, MsgId and an ISO ObservedAt timestamp; entry
welcomes additionally require User.Id. 64-bit identifiers remain strings.
Display accepts messages up to 24 hours old and 30 seconds of positive clock skew;
welcomes require an entry no older than two minutes. Delayed chats remain readable
without replaying old entry greetings. New service packets from all rooms are
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
masking and text escaping. Closing the popup, switching views, covering the window and resizing it keep
reception mounted. Stop, logout, page exit and leaving the Buzhoushan theme stop it. Reconnect clears the
message view and disables welcomes. No previous entries are replayed on enable.

Separately connect the global voice coordinator and enable “入场自动欢迎”.
Welcomes use the existing native voice call and its interruption behavior. No
WebRTC VAD/output-buffer events or fabricated audio-idle claim are required. A
connected call with available playback can request a welcome without first
speaking to the coordinator. Recovery or unavailable/blocked playback pauses requests. The user's welcome
switch remains enabled and fresh entries wait for the call to become ready. Native interruption is not a guarantee against overlapping
speech, and an interrupted welcome is never automatically restarted.

A fresh eligible entry follows this path:

`collector → panel validation/deduplication → authenticated global voice socket →
server priority/rate checks → thread/realtime/appendText → existing voice call`

The default greeting is “嗨，你好，欢迎光临”. The broadcaster can edit and explicitly save 1–200 characters in the message panel. The transcript UI displays
conversation; it is not an input integration point. No new call, project task,
external TTS or chat text is sent by the welcome path. The separate on-request chat lookup is described below. An entry display nickname is transient speech data when the saved template uses `{用户名}`. Rejection receipts identify protocol/time, duplicate/cooldown, task, recovery or
transport reasons instead of labeling every rejection as busy. Both collector and browser timestamps allow thirty seconds of positive clock skew. The welcome queue expires after two minutes. Native acceptance
is not confirmed audible playback or a prerecorded exact-audio guarantee.

Each distinct entry may be welcomed, including a returning viewer. Welcomes are
spaced three seconds apart, and entries arriving during cooldown wait in order
(up to 50 pending entries, two minutes). The same packet is never welcomed twice.
Background project jobs and unknown project status do not silence the coordinator.
Only an active coordinator tool call or an in-flight result report defers a welcome.
Explicit temporary refusal receipts may retry within the entry's two-minute window;
unknown or accepted delivery is never replayed. No microphone interruption or new
voice call is performed. Stopping collection clears the queue and welcome switch.

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

## 16:9 capture and background rendering

The toolbar's “16:9 画布” fits an actual 16:9 rectangle inside the viewport without
nonuniform scaling. The status bar shows its current CSS pixel dimensions; hover
for margins to crop. Capture that rectangle and fit proportionally to 1920×1080.
Capturing the entire ultrawide window and stretching it still distorts the image.
Voice/message panels are positioned and drag-clamped inside the canvas.

“直播采集设置” downloads an inspectable `AgentFleets-Broadcast.cmd` launcher.
It finds installed Edge/Chrome and opens a separate browser profile with Chromium's
`--disable-backgrounding-occluded-windows`, `--disable-background-timer-throttling`,
`--disable-renderer-backgrounding` and `--disable-features=CalculateNativeWinOcclusion`.
The separate profile is essential: an existing normal browser process can ignore
new startup flags. It requires one sign-in and preserves its own profile thereafter.
It does not disable browser security, start voice, or grant microphone/local-network
permissions. The explicit `?broadcast=1` entry chooses Buzhoushan, focus and 16:9.
The activity dock also retains its two-second polling interval when hidden.

Chromium's [switch definitions](https://chromium.googlesource.com/chromium/src/+/HEAD/content/public/common/content_switches.cc)
confirm these background rendering/timer controls. This launcher is the first
Windows capture mitigation, not proof of occlusion capture working. Home is offline
during development: actual Windows/Live Companion occlusion, capture mode and audio
need evening verification. Keep the source window unminimized during that check;
window capture may stop on minimization regardless of timers. If the browser path
still freezes under cover, an Electron wrapper with `backgroundThrottling: false`
provides explicit rendering control ([Electron docs](https://www.electronjs.org/docs/latest/api/browser-window)).

The earlier welcome release preserves Agent 0.30.100. On-request chat lookup below requires Agent 0.30.101; prior versioned artifacts remain immutable.
Publish a separately tested image via `packaging/deploy-control-plane.py`. Active
calls defer publication; never force a restart or refresh. Load the new page after
the current call ends. Collector and Companion require no restart for this release.

## Saved welcome message

The editor persists the trimmed greeting under `agentfleet.live-interactions.welcome-text`
in this browser's localStorage for this site. It is not an account/server preference,
is not scoped by room or voice host, and is not synchronized to another browser or
device. It survives refresh/reconnection and is shared by accounts using the same
browser profile/site storage. Empty, invalid or unreadable storage falls back to the
existing default. Failed writes leave the prior saved greeting active.

Editing and Cancel never affect speech. Save updates the text used when the next
eligible welcome request is sent, including an entry still waiting in the queue;
an already sent request is unchanged. Saving neither enables automatic welcome
nor creates/replays an entry. Other already-open tabs keep their current text until
reload. The browser sends the saved text with the authenticated welcome request;
the server validates it and quotes it as speech data in a no-tools, interruptible
welcome instruction. Old clients without this field retain the default. No new
persistent server setting or Agent binary is introduced.

Entry provenance, freshness, event deduplication, the three-second interval,
queue expiry, tool/report priority, and no-replay on unknown/accepted delivery
remain unchanged. Apply the frontend/backend release together through the guarded
publisher. An active call defers publication; load the new UI only after the call
naturally ends. Automated fixtures verify saved/draft/failure behavior and custom
speech transport; actual native audible wording remains subject to the voice model.

## Viewer-name template

`{用户名}` can appear anywhere and more than once. The editor offers a caret/selection
insertion button and a parameter hint; insertion changes the draft, and Save is
required. The unchanged default contains no token and therefore adds no nickname.
Only the template is stored in browser localStorage, never its expanded visitor text.

Verified source path: HomeDouyinCollector `src/protocol.mjs` maps
`event.user.nickname` to `Data.User.Nickname`; the panel parser maps it to
`LiveEvent.name`. NativeVoicePanel sends the existing display-masked name as
`live.welcome.viewerDisplayName` together with the saved `welcomeText`. This does
not use viewer IDs, invented names, chat text or a remembered alias as a fallback.
The server strips control/bidi-override characters, trims and bounds the nickname
to 200 characters, then replaces all exact tokens once with that name or “这位朋友”.
Replacement metacharacters and tokens inside a name remain literal. Expanded
speech over 2,000 characters is rejected before gate reservation.

The server sends the quoted expanded text in the existing low-priority welcome
report; the Agent's `reportPanelVoice` forwards it through
`thread/realtime/appendText` on the existing coordinator call. The instruction
explicitly treats nicknames as untrusted words to speak, never commands or memory
updates. This path writes no application long-term preference/profile records.
It does not promise removal from the native session transcript or provider history,
and a model instruction is not a guarantee of exact pronunciation or behavior.
The nickname alone cannot create a welcome: the same entry provenance, deduplication,
freshness, cooldown, tool/report priority and recovery gates still apply.

Synthetic tests cover collector parsing, nickname socket transport, server report
expansion, literal instruction-like names, missing/invalid names, repeated tokens,
editor insertion/save and absence of preference/task writes. Actual Home/Windows
capture and native audible output have not been tested for this change. No collector
or Agent binary update is needed. Frontend and backend must be published together
through the voice-safe publisher; current pages acquire the editor on a later load
after calls naturally end. Recording is not added.

## On-request viewer questions (Agent 0.30.101, schema 58)

Accepted real `chat` events alone enter a bounded browser upload queue and the
CSRF-protected `/api/live-chat` endpoint. Entry/welcome and other interaction text
never enter this store. It works without a voice call or the welcome switch.
The parser retains the collector source/transport allowlist, message/room/viewer
IDs, nickname, text and observed time. The server independently validates these
fields, but source labels are not cryptographic proof of genuine Douyin capture.
The existing display masking is applied before upload. Text uses the existing
2,000-character parser limit; `contentTruncated` flags an incomplete body.

`live_chat_messages` in the control-plane SQLite database is scoped by workspace
and authenticated user, shared by that account's browsers and calls, not tied to
a selected project or voice host. It retains at most the newest 100 chat records
across rooms ordered by source observation time. Room/message ID deduplication
does not collapse several messages by the same viewer. An event is queryable for
24 hours from its observation time; overflow is deleted on ingestion, expiry is
filtered at read and deleted on ingestion or the normal transient-state sweep.
This is bounded operational evidence, not a long-term preference or infinite
memory. Database/WAL files and deployment backups follow existing operational
backup policy; expiry is not a promise of secure erasure from those backups.

Uploads are batched (20 each, normally once a second), with a 100-entry transient
retry buffer and five-second failure backoff. Diagnostics report failed saves or
overflow. Stop/logout/page disposal cancel pending uploads; already saved records
remain until expiry/overflow. A request already accepted by the server is not
undone by cancellation. There is no historical collector replay or capture while
the page is closed, and a network loss can leave the latest records unavailable.

The coordinator's own `agentfleets_panel` gains `live.chat.search` with `nickname`,
`userId`, `roomId`, optional `query` (literal body substring), and `cursor`.
Nickname lookup prefers normalized exact matches, falling back to substrings;
user and room IDs disambiguate results. Results include actual message IDs,
timestamps, truncation, viewer ambiguity and pagination. Pages are bounded without
cutting a chat body or JSON; changing results invalidate the cursor. Missing viewer
IDs remain missing and must not be inferred from names. No-match is explicit.

The native realtime protocol exposes these tools through the same coordinator's
client tool bridge. The bridge retrieves evidence only, returns it to that same
voice conversation, and realtime answers there. It never creates a project task,
starts a working session, saves a Q&A todo or delegates answers to a project worker.
Instructions require the broadcaster's current explicit request, e.g. “回答钓无定法的问题”.
Ingestion/connect/recovery do not trigger lookup, model context injection or speech.
Ambiguous viewers or several distinct questions prompt clarification unless the
broadcaster selected latest/all. Viewer text is quoted evidence, never task authority.
After a chat lookup, the server blocks mutating coordinator tool actions for that
same user utterance segment; a new broadcaster utterance permits normal tools again.
Duplicate transcript snapshots and transport recovery do not release this guard.
Model/tool instructions still cannot guarantee perfect semantic interpretation.

The query uses existing active-call ownership, host-epoch and recovery fencing,
and existing tool-priority protection postpones welcomes while it runs. Local
synthetic tests cover store capacity/expiry/reopening, tenant isolation, literal
search/pagination, multiple messages, input rejection, silent ingestion, authenticated
upload, same-call tool result, blocked mutation and a new user request. Actual Home
capture, microphone recognition of a nickname and native spoken Q&A are not proven
by those fixtures.

Publish the verified backend/web plus immutable Agent 0.30.101 artifacts using the
guarded publisher. Then safely update the selected voice host when its calls/tasks
allow it, and load the new page/start a new coordinator call. Publishing download
artifacts does not itself upgrade a running host. Do not restart current calls or
live Companion. Old Agent tool schemas do not expose this query.
