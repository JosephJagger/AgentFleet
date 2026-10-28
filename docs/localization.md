# Interface localization

AgentFleets supports English (`en`), Simplified Chinese (`zh-CN`), Traditional
Chinese (`zh-TW`), Japanese (`ja`), Korean (`ko`), German (`de`), French (`fr`),
Spanish (`es`), Italian (`it`), Dutch (`nl`) and Brazilian Portuguese (`pt-BR`).

The selected language is saved in the browser. On a first visit, supported
languages are matched against the browser's ordered preferences. Traditional
Chinese script and Taiwan/Hong Kong/Macau preferences select `zh-TW`; Portuguese
preferences select the available Brazilian edition. Unsupported preferences fall
back to English. The theme preference is independent of the language.

## Writing conventions

Localize the action and its consequences, rather than copying the source sentence
structure. Buttons use familiar, concise verbs. Destructive actions must still
distinguish removal from a list, removal from Git staging, deletion, and permanent
deletion. Planning, permission approval, starting execution, and automatic review
are separate concepts in every language.

Use consistent terms for hosts, projects, sessions, worktrees and approval modes.
Traditional Chinese uses Taiwan software terminology such as 專案、檔案、設定、
工作階段 and 快取. German uses the polite form or neutral action labels; French
uses vous, Spanish uses tú, Dutch uses je, and Portuguese uses Brazilian wording.
Japanese and Korean notices use natural, polite software language. Theme names
use familiar local titles where available.

Translate application-owned labels and notices only. User messages, session and
project names, assistant replies, terminal output, paths, model IDs, flags and
configuration values stay unchanged. Preserve every numbered template argument
and technical token. Format dates and numbers with the selected locale; use local
count forms rather than concatenating an English plural suffix.

## Implementation

`apps/web/src/i18n/locales.ts` defines supported tags, native picker names, browser
matching and count forms. Chinese source strings are the catalog keys; the other
ten catalogs must have the same keys as `en.json`.

Additional catalogs load on demand, before the interface switches. Failed loads
keep the current language and allow a retry. The initial render waits for the
preferred catalog; if it cannot load, English remains usable without overwriting
the saved preference. A newer selection takes precedence over an older pending
download. Locale changes preserve the current session, draft and user content.

The login page has its own type scale and uses the existing theme palettes and
scene assets. Latin and CJK headings have different line spacing and font stacks.
Theme names may wrap; mobile login controls remain readable without browser zoom.
Verification emails and web app manifests use the selected language too. Full-width
verification-code digits are normalized to ASCII before submission.

## Validation

Run the web localization, theme and email-login tests, the control-plane email
authentication tests, and the identity email tests. Catalog checks reject missing
keys, empty values, broken template arguments and leftover translation markers.

Check desktop, phone and narrow-phone layouts in every locale and theme. Include
the email step, code step, invalid-code feedback, resend countdown and language
switching with an existing draft. Check long action labels in settings, session
configuration and confirmation dialogs. Browser tests must mock authentication
requests and must not send actual verification emails.

## Release scope

This change affects the web app, control-plane login schema and identity-service
email templates; it does not require a host Agent update. Publish the web app and
control plane together. Include the identity-service change in the coordinated
release for localized verification emails. An older control plane rejects the new
locale tags, while an older identity service falls back to English email text.
Follow the guarded publication workflow in `release-provenance.md`.
