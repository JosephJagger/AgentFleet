# Writing assistance

Multi-domain project design and the audited status of question/answer learning: [跨领域输入辅助与对话经验库](writing-assistance-project.md). Planned capabilities in that document are not current release features.

The composer combines curated Chinese/English terminology, 3,943 filtered CSpell software terms, and Fuse.js fuzzy matching. CSpell words are a spelling vocabulary, not definitions or a semantic model. Regenerate the pinned dictionary with `npm --prefix apps/web run prepare:terms`; the source package is pinned in the lockfile and its MIT license is distributed at `/software-terms-LICENSE.txt`.

Input assistance defaults are configured in Settings; each session can inherit or override individual options. Mobile users tap suggestions; desktop users can use Tab, arrow keys, and Escape. IME composition and text selections suppress completions.

AI optimization sits immediately to the left of Send or Stop in a shared action pair. Shortcut hints occupy their own space and can wrap without overlapping buttons.

Desktop candidates render in a floating surface anchored above the composer, outside its scroll container. Changing candidate count does not resize the input area. Position follows resize and scroll; touch layouts keep the inline candidate strip.

## Input assistance settings and automatic learning

Settings → Input assistance contains four account-wide defaults: terminology, wording suggestions, local NLP, and automatic vocabulary/wording accumulation. Sessions inherit individual options and can override them in the expandable Input assistance group. Restore global defaults removes the session overrides. Preferences are stored on the backend and refresh on navigation/focus; they are no longer browser-only. Old browser session choices are imported when that session has no backend override. Existing disabled learning choices survive migration.

No dictionary approval or question/answer rating screen is required. Newly persisted user and assistant messages automatically contribute filtered terminology and explicit wording mappings. New entries become active immediately; eligible old pending entries are re-extracted from retained source evidence. The extractor recognizes marked inline terms and explicit quoted definitions. It excludes fenced code, obvious sensitive text and selected negative/speculative wording. This is a conservative lexical filter, not a factual verification engine or arbitrary language learning.

When an assistant explicitly proposes a professional rewrite, its source turn must identify exactly one retained user question in the same session, execution segment, thread and turn. The learned mapping keeps the original question alongside the proposed wording so details are retained. Missing identifiers, multiple questions, code blocks and uncertain examples are skipped. There is no model training or retrospective scan of every chat.

Automatic entries are account-owned and default to the source project. Source event/question references are retained. Expired/deleted or sync-disabled source content removes automatic entries during reads and maintenance. Existing manually saved entries remain independent. Disabling learning stops accumulation, while existing usable entries remain available. Skipped events advance the watermark so re-enabling does not replay them. At the 500-entry account limit, the least-used oldest automatic entries can be replaced; manual entries and deletion fingerprints are preserved. Identical repeated evidence refreshes the source without replacing conflicting meanings.

The retired question/answer feedback API remains available for older clients, but its UI is removed and ratings are not part of automatic learning. Internally retained source events provide provenance; users only select input-assistance options.

## Local bilingual NLP and semantic suggestions

See [the project status and evaluation](writing-assistance-project.md) for the 29 bilingual concepts, 147 authored examples, six domains, local multilingual model, confidence gates and known Chinese recall limits. The browser now contains 4,029 distinct terminology labels including software spelling words; this is not a count of understood concepts. Generate domain terms with `node apps/control-plane/scripts/export-writing-terms.mjs`.

After a 600 ms pause, Chinese or English drafts go to `POST /api/sessions/:id/writing-nlp`. ICU lexical matching runs first; unmatched expressions can use local CPU embeddings in a worker. The model is downloaded and checksummed at image build time. Runtime remote model access is disabled. Neither API keys nor an external AI provider are required. Model startup, worker overload, timeout or failure leaves lexical matching available.

Session configuration → **Local NLP suggestions** is on by default and requires wording suggestions. The existing authentication, CSRF, 90/minute account rate limit, 2,000-character draft limit, 300-character final-sentence limit, no-store responses, IME handling, cancellation and stale-response protection remain. Drafts are not persisted. The worker has a four-request admission cap and a 1.5-second response deadline; the browser aborts after 2.5 seconds.

Suggestions retain the original sentence after an authored professional task goal; they do not freely rewrite or infer a root cause. Confidence gates reduce errors but do not establish arbitrary language understanding. Confirmed private vocabulary remains in immediate matching; semantic retrieval currently indexes only the authored corpus.

Mobile suggestions keep their actual height up to four lines with ellipsis, remain after keyboard dismissal, and edit only the draft. Desktop candidates float without resizing the composer. Delayed choices append after immediate ones.

## Optional AI understanding (external service)

Settings → AI understanding accepts a Chat Completions compatible API base URL, an explicit model identifier, optional API key, and enable switch. No provider/model is selected automatically. HTTPS is required except for loopback HTTP. With Docker, loopback refers to the container, not the host.

Clicking Improve with AI sends the current draft and at most 30 available dictionary entries to the configured provider. Nothing is sent on each keystroke or on configuration save. It does not start a Codex turn, execute tools or submit a chat message. Provider charges may apply. Suggestions are complete editable draft alternatives; ambiguous input can produce no suggestion. Generation is bounded by a 12-second timeout, 12 requests per account per minute, and a small response/token limit. Failures leave the draft, dictionary and local completions usable. Editing the draft or changing sessions aborts/discards outdated responses.

The provider must accept `POST <base>/chat/completions`, `messages`, `response_format: {type: "json_object"}` and `max_tokens`. Configure a compatible model; support varies among providers. Live model quality cannot be verified without a configured service. Responses are validated and never executed.

API keys are encrypted with AES-256-GCM in SQLite. The random encryption key is stored in `writing-ai.key` alongside the database with mode 0600. Back up both the database and this file. APIs return only whether a key exists; the browser never receives saved keys. Changing provider URL clears the previous key unless a new one is supplied, and redirects are disallowed.

The current release adds schema 31 for account defaults, session overrides and automatic-entry provenance. Deploy backend + Web using `packaging/Dockerfile.control-plane` with a verified prior image so published Agent downloads remain unchanged. Older binaries cannot read schema 31: rollback requires the corresponding pre-upgrade database backup as well as the previous image, and must account for any new data written after deployment.

Sources: [CSpell dictionaries](https://github.com/streetsidesoftware/cspell-dicts), [Fuse.js](https://github.com/krisk/Fuse), [structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
