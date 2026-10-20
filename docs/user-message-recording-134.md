# User message recording — Agent 0.30.134

Claude's SDK input stream does not guarantee a user-message echo. Record consumed
inputs with their native UUID before yielding them to the SDK. The same path
covers original and additional prompts; image-only messages remain user messages.
Native history and echoes keep the same item identity for timeline deduplication.
Unconsumed queued inputs are not presented as delivered.

ACP ordinary sends already record a user message. Native user chunks from Grok
interjection were excluded by the turn-final flush. Flush previously unpublished
user items too, and mark the ordinary send as already persisted. Do not append
new chunks into that completed ordinary message.

Codex's native item notifications pass userMessage through the sanitizer and
durable event path; no equivalent omission was found in that path. This is code
and isolated-test coverage, not a claim of every provider/account being tested
against its live service.

Validation: Claude ordinary/steered input, repeat UUID, text/image history;
Grok original plus native interjection recorded separately; ACP runtime, Codex
session/daemon runtime, image/history tests; provider-independent frontend
timeline tests including the Chinese “你” label.

Existing skipped history is not replayed by this release. In particular, the
reported Claude question remains in native history and command content, but its
already-advanced history checkpoint needs a separate bounded recovery; retention
and synchronization exclusions must not be bypassed.

Hosts need Agent 0.30.134. Publication makes the new immutable artifacts available;
busy hosts retain the existing safe upgrade policy.
