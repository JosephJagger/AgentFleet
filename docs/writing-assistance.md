# Writing assistance

The composer combines curated Chinese/English terminology, 3,943 filtered CSpell software terms, and Fuse.js fuzzy matching. CSpell words are a spelling vocabulary, not definitions or a semantic model. Regenerate the pinned dictionary with `npm --prefix apps/web run prepare:terms`; the source package is pinned in the lockfile and its MIT license is distributed at `/software-terms-LICENSE.txt`.

Term completion and wording suggestions can be disabled separately in session configuration. Those display preferences stay in the browser. Mobile users tap suggestions; desktop users can use Tab, arrow keys, and Escape. IME composition and text selections suppress completions.

Desktop candidates render in a floating surface anchored above the composer, outside its scroll container. Changing candidate count does not resize the input area. Position follows resize and scroll; touch layouts keep the inline candidate strip.

## Automatic learning

Learning is enabled by default for newly received, successfully persisted `item.completed` user and assistant messages. There is no retrospective scan of conversation history, no access to unsynced native chats or project files, and no background model call. Messages from projects with body sync disabled, expired/deleted bodies, reasoning and tool output are excluded.

The lexical extractor recognizes inline-code terms and explicit quoted definitions (for example, `“等我输完再查”称为“防抖”` or `"wait until typing stops" means "debounce"`). It skips fenced code and obvious credential/URL/email patterns. This filter reduces accidental collection; it is not a complete sensitive-data classifier. Extracted candidates require confirmation before they affect suggestions. Confirmation, editing and deletion are available in session configuration → Dictionary and automatic learning.

Dictionaries are account-owned. Personal entries apply across projects; project entries apply only to that project. Entries store source session/event identifiers without duplicating complete messages. Candidate and confirmed vocabulary are independent of source transcript retention and remain until deleted. Deleted entries are erased except for a scoped fingerprint that prevents automatic relearning. Turning learning off keeps existing entries and skips newly received events; re-enabling does not process the skipped interval. Accepted entries receive a bounded usage counter for ranking, which is not evidence that their meaning is correct. Automatic extraction is capped at 500 records per account, including deletion fingerprints.

## Local Chinese NLP suggestions

The existing browser dictionary stays immediate. After a 600 ms pause, Chinese drafts are also matched by the control-plane at `POST /api/sessions/:id/writing-nlp`. This uses Node's ICU-backed `Intl.Segmenter`, multi-word synonyms and concept combinations across ten development scenarios (session expiry, page performance, large lists, click response, mobile layout, save failure, inconsistent data, input debounce, duplicate submission and API failures). It is lexical NLP retrieval, not a trained language model or arbitrary semantic understanding. No package download, model file, GPU or external API is required.

The backend considers only the final sentence, up to 300 characters, in drafts up to 2,000 characters. It adds professional wording while retaining the original sentence, preserves earlier sentences, declines selected negative/resolved expressions and ambiguous multiple matches, and skips obvious code/credential/URL inputs. These are conservative filters, not complete language or sensitive-data understanding. Unknown wording can still return no result. Confirmed learned vocabulary continues to be used by the immediate browser layer; this NLP layer currently uses its own versioned development concepts.

The independent **Chinese language suggestions** switch is enabled by default in session configuration and also requires **Prompt and wording suggestions**. Turning either off stops requests. Drafts go only to this application's authenticated backend, are not written to the database or request-body logs, and receive `Cache-Control: no-store`. Requests require session access and CSRF and are limited to 90 per account per minute. The frontend suppresses requests during IME composition, selection, slash commands and mid-draft caret editing. Requests debounce, time out after 2.5 seconds, and are aborted on editing, session/account changes, dismissal or opt-out. Late responses cannot replace another draft. Failures are silent and leave immediate completions usable.

Backend suggestions share the existing mobile candidate UI: actual content height up to four lines, then ellipsis; dismissing the keyboard retains the candidates. Adoption only edits the draft. The first immediate choices keep their order and duplicates by label are removed. Semantic vector retrieval is a future extension to the same offset-based response contract; it is not enabled or claimed in this release.

References: [ECMA-402 Segmenter specification](https://tc39.es/ecma402/#segmenter-objects), [Node internationalization support](https://nodejs.org/api/intl.html).

## Optional AI understanding (external service)

Settings → AI understanding accepts a Chat Completions compatible API base URL, an explicit model identifier, optional API key, and enable switch. No provider/model is selected automatically. HTTPS is required except for loopback HTTP. With Docker, loopback refers to the container, not the host.

Clicking Improve with AI sends the current draft and at most 30 confirmed dictionary entries to the configured provider. Nothing is sent on each keystroke or on configuration save. It does not start a Codex turn, execute tools or submit a chat message. Provider charges may apply. Suggestions are complete editable draft alternatives; ambiguous input can produce no suggestion. Generation is bounded by a 12-second timeout, 12 requests per account per minute, and a small response/token limit. Failures leave the draft, dictionary and local completions usable. Editing the draft or changing sessions aborts/discards outdated responses.

The provider must accept `POST <base>/chat/completions`, `messages`, `response_format: {type: "json_object"}` and `max_tokens`. Configure a compatible model; support varies among providers. Live model quality cannot be verified without a configured service. Responses are validated and never executed.

API keys are encrypted with AES-256-GCM in SQLite. The random encryption key is stored in `writing-ai.key` alongside the database with mode 0600. Back up both the database and this file. APIs return only whether a key exists; the browser never receives saved keys. Changing provider URL clears the previous key unless a new one is supplied, and redirects are disallowed.

This release adds schema 29. Deploy backend + Web using `packaging/Dockerfile.control-plane` with a verified prior image so published Agent downloads remain unchanged. Older schema-28 binaries cannot read schema 29: rollback requires the corresponding pre-upgrade database backup as well as the previous image, and must account for any new data written after deployment.

Sources: [CSpell dictionaries](https://github.com/streetsidesoftware/cspell-dicts), [Fuse.js](https://github.com/krisk/Fuse), [structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
