# Provider image input

AgentFleets forwards clipboard/file-picker images as image bytes, never as a
filename, remote URL, or an OCR/text replacement. Existing limits apply: four
PNG/JPEG/WebP images, each prepared by the browser to at most 128 KiB. Image-only
messages are supported. The cloud image quota, retention, owner scoping and
command idempotency continue to apply.

## Capability and delivery

- Codex: existing App Server image capability and selected-model input modalities.
- Claude Code: existing SDK image blocks; admission and dispatch no longer depend
  on the unrelated Codex catalog on the same machine.
- Cursor, Qwen Code, Kimi Code, CodeBuddy Code, Grok Build: ACP `session/prompt`
  image blocks (`type`, `mimeType`, base64 `data`). Enable only when the installed
  runtime's `initialize.agentCapabilities.promptCapabilities.image` is true,
  except for the specific Grok compatibility case below.

The control plane checks the selected provider at admission and again before
first delivery. The local ACP runtime checks the capability negotiated by the
actual session connection (another connection's newer discovery cannot override
it). If support disappears after a CLI change, an unsent command is refused,
not silently converted to text or replayed. Settings, files, plugins and steering
remain subject to their existing separate capability restrictions.

Native history image blocks are mapped to the existing image renderer and storage
format. Unsupported/oversized native history images get a text placeholder, not
an arbitrary URL fetch. Existing per-message and snapshot bounds remain in force.

## Grok 1.0.62 exception and validation

The official Grok source accepts `ContentBlock::Image` in its prompt parser but
initialization constructs prompt capabilities with only embedded context enabled:

- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/prompt_parser.rs
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs
- ACP image contract: https://agentclientprotocol.com/protocol/v1/content

On 2026-10-17 an isolated Linux Grok 1.0.62 stable native ACP session received two
128x128 synthetic PNGs, red and blue, without naming those colors in the prompt.
It answered `Red, blue.` and completed normally; no tool requests were made.
The CLI advertised `image:false`. This proves image input for that installed
version/model (reported model: grok-4.7), not every model, OS, or future release.

The workaround is restricted to CLI version `grok 1.0.62` and the native
`initialize._meta.grokShell === true` marker. Other versions must advertise
support; extend this exception only after new evidence, never by assuming that
all subsequent versions have the same bug.

Synthetic protocol and database tests cover all five ACP providers, image-only
input, ordered multiple images, history, unsupported input, a withdrawn capability,
provider isolation and duplicate command admission. These are not native CLI
vision tests for Cursor, Qwen, Kimi or CodeBuddy. They require an installed CLI,
valid login and a model accepting images to perform those checks.

## Rollout

The panel/control plane and target connection service both need this change
(Agent 0.30.115). Older ACP connection services report images unavailable and
remain disabled. Existing CLI sessions keep their negotiated capability until
released/restored normally. Do not interrupt tasks or voice to update a host.
No provider install, account change or model switch is performed automatically.
