# Panel traffic hotfix

Opening a session previously turned every machine heartbeat and persisted event into dashboard, catalog and full recent-history requests. A three-minute production sample contained 1,414 HTTP requests, including 85 reads of one session's latest 100 events and 49 additional reads of its latest 50 events. These are server-wide counts, not a measurement of one browser's transferred bytes.

The shared UI now applies machine notifications directly, reconciles the dashboard at 30-second intervals while visible, and refreshes the selected detail on persisted changes. It unsubscribes old/background conversations. Command receipt polling remains enabled in the foreground and never resends commands.

Conversation refreshes use an opt-in, byte-bounded forward cursor with projection/content epoch checks. Empty deltas retain loaded history; epoch changes reload a snapshot. The new client requests one copy of event data and metadata-only websocket notifications, retaining immediate volatile output. Legacy websocket and history clients retain their existing contracts. GET JSON responses negotiate gzip, excluding identity endpoints; content-addressed JS/CSS/font files use immutable caching. No Agent executable changes are required; the transport is shared by all providers.

Validation covers web workspace behavior, multiple providers' incremental history, reconnect/cursor pagination, deleted content, stale epochs, workspace isolation, legacy and compact websocket subscriptions, unchanged volatile output, compression negotiation, static caching, and existing server command/approval ordering. Refresh an already-open browser once after publication to activate the frontend changes. Publication must not force reloads or terminate tasks/calls.
