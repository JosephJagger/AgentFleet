# Writing assistance

Multi-domain project design and the audited status of question/answer learning: [跨领域输入辅助与对话经验库](writing-assistance-project.md). Planned capabilities in that document are not current release features.

The composer combines curated Chinese/English terminology, 3,943 filtered CSpell software terms, and Fuse.js fuzzy matching. CSpell words are a spelling vocabulary, not definitions or a semantic model. Regenerate the pinned dictionary with `npm --prefix apps/web run prepare:terms`; the source package is pinned in the lockfile and its MIT license is distributed at `/software-terms-LICENSE.txt`.

Term completion and wording suggestions can be disabled separately in session configuration. Those display preferences stay in the browser. Mobile users tap suggestions; desktop users can use Tab, arrow keys, and Escape. IME composition and text selections suppress completions.

Desktop candidates render in a floating surface anchored above the composer, outside its scroll container. Changing candidate count does not resize the input area. Position follows resize and scroll; touch layouts keep the inline candidate strip.

## Automatic learning

Learning is enabled by default for newly received, successfully persisted `item.completed` user and assistant messages. There is no retrospective scan of conversation history, no access to unsynced native chats or project files, and no background model call. Messages from projects with body sync disabled, expired/deleted bodies, reasoning and tool output are excluded.

The lexical extractor recognizes inline-code terms and explicit quoted definitions (for example, `“等我输完再查”称为“防抖”` or `"wait until typing stops" means "debounce"`). It skips fenced code and obvious credential/URL/email patterns. This filter reduces accidental collection; it is not a complete sensitive-data classifier. Extracted candidates require confirmation before they affect suggestions. Confirmation, editing and deletion are available in session configuration → Dictionary and automatic learning.

Dictionaries are account-owned. Personal entries apply across projects; project entries apply only to that project. Entries store source session/event identifiers without duplicating complete messages. Candidate source availability is checked on read; unavailable candidates are erased and excluded. Confirmed entries are independently retained until deleted. Source roles are shown when available, with assistant claims marked unverified. Deleted entries are erased except for a scoped fingerprint that prevents automatic relearning. Turning learning off keeps existing entries and skips newly received events; re-enabling does not process the skipped interval. Accepted entries receive a bounded usage counter for ranking, which is not evidence that their meaning is correct. Automatic extraction is capped at 500 records per account, including deletion fingerprints.

## Local bilingual NLP and semantic suggestions

See [the project status and evaluation](writing-assistance-project.md) for the 29 bilingual concepts, 147 authored examples, six domains, local multilingual model, confidence gates and known Chinese recall limits. The browser now contains 4,029 distinct terminology labels including software spelling words; this is not a count of understood concepts. Generate domain terms with `node apps/control-plane/scripts/export-writing-terms.mjs`.

After a 600 ms pause, Chinese or English drafts go to `POST /api/sessions/:id/writing-nlp`. ICU lexical matching runs first; unmatched expressions can use local CPU embeddings in a worker. The model is downloaded and checksummed at image build time. Runtime remote model access is disabled. Neither API keys nor an external AI provider are required. Model startup, worker overload, timeout or failure leaves lexical matching available.

Session configuration → **Local NLP suggestions** is on by default and requires wording suggestions. The existing authentication, CSRF, 90/minute account rate limit, 2,000-character draft limit, 300-character final-sentence limit, no-store responses, IME handling, cancellation and stale-response protection remain. Drafts are not persisted. The worker has a four-request admission cap and a 1.5-second response deadline; the browser aborts after 2.5 seconds.

Suggestions retain the original sentence after an authored professional task goal; they do not freely rewrite or infer a root cause. Confidence gates reduce errors but do not establish arbitrary language understanding. Confirmed private vocabulary remains in immediate matching; semantic retrieval currently indexes only the authored corpus.

Mobile suggestions keep their actual height up to four lines with ellipsis, remain after keyboard dismissal, and edit only the draft. Desktop candidates float without resizing the composer. Delayed choices append after immediate ones.

## Question/answer history

Session configuration → **Questions, answers and feedback** reads retained exchanges on demand. Source events are associated by execution segment and native thread/turn IDs, keeping user questions and assistant replies separate. Missing IDs or roles are explicitly incomplete. Up to 500 retained relevant events and 30 groups are shown, with truncation indicated. Tool and reasoning output are excluded.

Useful/not-helpful feedback belongs to the current account. It is reversible and never automatically promotes an answer to confirmed vocabulary or truth. No transcript copy or historical model training job is created. Expired/deleted or sync-disabled source content is excluded on read; original conversation synchronization remains independent from learning preferences.

References: [ECMA-402 Segmenter specification](https://tc39.es/ecma402/#segmenter-objects), [local model settings](https://huggingface.co/docs/transformers.js/v3.8.1/en/custom_usage), [multilingual model](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2).

## Optional AI understanding (external service)

Settings → AI understanding accepts a Chat Completions compatible API base URL, an explicit model identifier, optional API key, and enable switch. No provider/model is selected automatically. HTTPS is required except for loopback HTTP. With Docker, loopback refers to the container, not the host.

Clicking Improve with AI sends the current draft and at most 30 confirmed dictionary entries to the configured provider. Nothing is sent on each keystroke or on configuration save. It does not start a Codex turn, execute tools or submit a chat message. Provider charges may apply. Suggestions are complete editable draft alternatives; ambiguous input can produce no suggestion. Generation is bounded by a 12-second timeout, 12 requests per account per minute, and a small response/token limit. Failures leave the draft, dictionary and local completions usable. Editing the draft or changing sessions aborts/discards outdated responses.

The provider must accept `POST <base>/chat/completions`, `messages`, `response_format: {type: "json_object"}` and `max_tokens`. Configure a compatible model; support varies among providers. Live model quality cannot be verified without a configured service. Responses are validated and never executed.

API keys are encrypted with AES-256-GCM in SQLite. The random encryption key is stored in `writing-ai.key` alongside the database with mode 0600. Back up both the database and this file. APIs return only whether a key exists; the browser never receives saved keys. Changing provider URL clears the previous key unless a new one is supplied, and redirects are disallowed.

The current release adds schema 30 for account-owned history feedback. Deploy backend + Web using `packaging/Dockerfile.control-plane` with a verified prior image so published Agent downloads remain unchanged. Older binaries cannot read schema 30: rollback requires the corresponding pre-upgrade database backup as well as the previous image, and must account for any new data written after deployment.

Sources: [CSpell dictionaries](https://github.com/streetsidesoftware/cspell-dicts), [Fuse.js](https://github.com/krisk/Fuse), [structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
