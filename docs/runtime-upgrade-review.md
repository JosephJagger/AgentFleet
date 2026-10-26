# Managed Codex upgrade policy

AgentFleets distinguishes a newly discovered release from a reviewed native adapter release. Automatic distribution does not imply automatic protocol adaptation.

1. Discover the official stable release and verify that every platform asset has a digest and size.
2. Check the version against the reviewed release/schema list, shared by the control plane and Agent. An unknown version remains pending adaptation before downloading artifacts. It is never compared against a fallback schema from an older release.
3. For reviewed releases, verify downloaded bytes, the Linux binary version and exact schema, isolated App Server handshake/configuration/history interfaces, and Code Mode execution. All four platforms need verified artifacts before the target changes.
4. Each host independently checks its platform binary, schema and dependencies. Update only when idle; activation retains the existing rollback transaction and health acknowledgement.
5. Temporary download transport failures retry up to three times. Integrity errors do not retry as if they were network failures. A successful check of the current managed runtime clears an earlier transient error in the host snapshot.

The native adapter review for 0.156.0 used the official digest-verified Linux executable in isolated Codex homes, without account credentials or provider requests. Checks covered legacy and paginated writer exclusion, same-ID release/resume, permissions, archive/unarchive, native deletion and unrelated-history retention; image delivery to a local Responses substitute and subsequent resume also passed. One initial deletion test rejected a changed preview before reaching the expected active-writer error; the repeated full lifecycle check passed. Windows/macOS behavior remains subject to local validation and platform testing; this is not a claim of a full cross-platform end-to-end certification.

Protocol differences reviewed against 0.154.0 include additive plugin/model/thread settings, new attachment methods, and image inputs accepting either a URL or file ID. Existing URL inputs remain supported. The removed `thread/rollback` method is not used by AgentFleets. Version-specific native-history cleanup remains restricted to its previously verified adapter; approving a runtime does not broaden destructive cleanup support.

## 中文

新版本发现与兼容适配分开处理：先检查版本是否进入已验证清单，再校验下载摘要、真实接口与执行依赖，最后等待主机空闲并在本机再次验证。未知版本显示等待适配，不再拿旧版本摘要比较，也不反复下载必然被拒绝的安装包。

网络故障最多重试三次，校验失败保持拒绝；后续成功检查会清除旧网络失败提示。0.156.0 已完成上述 Linux 隔离原生会话及图片测试，不调用真实模型、不改用户会话。macOS/Windows 仍需各主机本地验证，不代表已经完成所有平台的实机验收。

## Codex 0.158.0 review (2026-09-28)

Agent 0.30.50 adds the reviewed 0.158.0 protocol hash to both compatibility lists:
`5742a9a7dd41a8b44dca3138f506e013620d4a93573c792b1e5881c053f169a7`.
The official Linux archive was verified against its published SHA-256 before generating the schema. Compared with 0.156.0, the protocol adds gateway OAuth methods/notifications, optional MCP resource targets and HTTP origins, optional item timestamps, and enum values (`promax`, `flexUnavailable`). Existing request methods and required fields remain compatible; no adapter method was removed.

Isolated Linux native checks passed for legacy and paginated writer exclusion, release/resume with the same session ID, permission profiles, archive/restore, descendant-aware deletion and unrelated-history retention. Image input and referenced text survived a turn against a local mock Responses server and subsequent native resume. No user credentials or real model requests were used. An initial legacy deletion check hit the existing preview-change race; a full repeat passed all three tests. Empty never-used native threads still do not necessarily persist; this release does not claim to change that behavior.

The promotion worker must still validate version/schema, isolated App Server interfaces and Code Mode execution, and verify all four platform artifacts and helpers before publishing the target. Windows/macOS activation remains subject to each host's local validation and health acknowledgement. Busy/offline hosts wait; version-specific destructive history cleanup support is not broadened.

0.158.0 已完成上述 Linux 隔离测试；新增协议为兼容性扩展。Agent 0.30.50 包含对应验证清单，主机仍须空闲、本地验证通过后才能升级，失败保留回退机制。离线主机恢复连接后再处理。

## Codex 0.160.1 review (2026-10-06)

Official release: https://github.com/openai/codex/releases/tag/rust-v0.160.1

The Linux musl archive passed its official SHA-256 (`9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f`). Its generated App Server v2 schema is byte-identical to 0.159.2: `81a88c04ae4984b16d73080f4109d0477682bc76c8adbe483e371175ce54c054`, including realtime methods and voice enums. Isolated version, initialize, config/read and thread/list probes passed. Native legacy/paginated writer exclusion, release/resume, archive/restore, deletion isolation and image delivery through a local mock Responses server passed without real account credentials or model calls.

Agent 0.30.75 adds the reviewed release and explicitly keeps native session/panel voice available on 0.160.1. Unknown versions remain gated. This verifies protocol compatibility, not a live microphone call. The central validator must still verify all platform binaries and helpers plus Code Mode execution before publishing the managed target. Hosts apply only after idle-time local validation and health acknowledgement; the previous runtime remains available for rollback. Version-specific destructive history adapters are unchanged.

0.160.1 已通过 Linux 隔离验证，与 0.159.2 的 App Server v2 协议完全一致；连接服务 0.30.75 同时适配语音能力判断。托管验证器完成四平台文件及执行依赖校验后才晋升，主机继续按空闲、本地验证、健康确认的流程升级。

## Codex 0.162.1 review (2026-10-12)

Official release: https://github.com/openai/codex/releases/tag/rust-v0.162.1

The release is neither draft nor prerelease. The Linux musl archive matches the official SHA-256 `86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057`; the generated v2 schema is `0bf5254bede109d4ae03ce2e81372e4c93a30b359c0749ec7dce7a9382a7f857`.

Compared with 0.160.1, there are no removed request methods or schema definitions. Changes include optional attachment-owner/prediction interfaces, task provenance fields, browser extension requirements, MCP OAuth login identifiers, and the `partial_answer` message phase. `namespaceTools` is removed from provider capabilities; the existing adapter already reports omitted flags as unavailable rather than assuming support. Skill paths remain strings. All 22 realtime definitions are unchanged. Unknown versions remain blocked; no destructive history adapter is broadened.

Isolated Linux probes passed version/schema/initialize/configuration/history checks, legacy and paginated writer exclusion, same-ID release/resume, policy verification, archive/restore, subtree deletion protection and unrelated-history retention. Image delivery and stored history passed against a local Responses fixture. Native browser MCP discovery passed. Code Mode executed the no-tool arithmetic probe successfully. No user credentials, real model requests, microphone calls or existing sessions were used. A regression covers partial answers remaining dialogue without declaring an active turn complete.

The native writer test previously captured a deletion preview before another writer resumed a descendant. Native metadata can change on resume, so the stale-preview guard sometimes rejected the request before the expected writer-ownership check. The test now previews after acquisition to reach the intended check; production deletion protections are unchanged. All five opt-in native checks then passed together.

Agent 0.30.95 carries the reviewed hash and unchanged realtime capability gate. The central validator must still verify all four platform binaries, execution helpers and sandbox helper before publishing the target. macOS/Windows artifacts are verified by digest; physical-device operation and live voice are not certified by these Linux tests. Hosts apply only when idle, repeat local validation and retain rollback health acknowledgement.

## Codex 0.163.0 review (2026-10-17)

Official release: https://github.com/openai/codex/releases/tag/rust-v0.163.0

The release is neither draft nor prerelease. The Linux musl archive matches the GitHub-published SHA-256 `beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4`; `--version` reports `codex-cli 0.163.0` and the generated v2 schema is `d204b96d8560d56600127423b89df9db471b3e22338e8809bb91d5a952998978`. The same procedure reproduced the documented 0.162.1 archive and schema hashes, which was used as the control.

Compared with 0.162.1, no definition or request method is removed and no required field is added. Additions: `ThreadReadState*`/`ThreadUnreadPosition` definitions, optional `ThreadListParams.excludedThreadIds`, optional `TurnToolOutput.retain`, `RealtimeVoicesList.v3`, and new `RealtimeVoice` values. AgentFleets keeps its own explicit voice allowlist, so the new voices are not exposed until reviewed.

Isolated Linux checks with the official binary (temporary root-owned directory, empty Codex homes, no account credentials or real model requests) passed: legacy and paginated writer handoff, on-disk conversation read without resume, and image delivery to a local Responses fixture with release/resume. The Agent carries the reviewed hash and keeps the realtime capability gate. The central validator must still verify all four platform binaries and helpers before promotion; macOS/Windows are not certified by these Linux tests.

## Codex 0.163.0 兼容性评审（2026-10-17）

协议与 0.162.1 相比只有新增：无删除、无新增必填字段。官方 Linux 安装包摘要核对一致，版本与协议哈希已写入已验证清单；Linux 隔离测试（会话互斥/恢复、历史读取、图片）全部通过，未使用账号或真实模型请求。新增的语音名称暂不开放。验证器仍须校验四平台文件后才晋升，主机照旧空闲、本地验证后才升级。

## Codex 0.164.0 pre-upgrade compatibility review (2026-10-26)

**Result: the tested existing Linux adapter paths pass; rollout has not been enabled.**
This is the requested compatibility assessment before upgrading AgentFleets, based
on source commit `3f1f8e790bbf5b8596da3fca28fc0a71256f9174` (Agent 0.30.148).
No reviewed-version list, voice gate, managed target, installer baseline or live
service was changed by this assessment.

Sources: [official Codex changelog](https://developers.openai.com/codex/changelog),
[official release](https://github.com/openai/codex/releases/tag/rust-v0.164.0).
GitHub's latest-release endpoint returned `rust-v0.164.0`, published
`2026-10-23T04:48:10Z`, with both `draft` and `prerelease` false.

### Artifact and protocol evidence

- All nine release archives required by the current promoter were downloaded,
  checked against the official size and SHA-256, and checked for the expected
  sole archive entry: four Codex binaries, four Code Mode hosts, and Linux bwrap.
- Linux Codex archive SHA-256:
  `90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4`.
- Linux Code Mode archive SHA-256:
  `feade7026436baa4e82e898050c7ef82a8adbd98163dc504771275b5ef224f2f`.
- Linux bwrap archive SHA-256:
  `60cd1c139823eabac2e4544cc75081d02af5100cfd276efa378dd48a123e109d`.
- The executable reports `codex-cli 0.164.0`. Generated ordinary App Server v2
  schema SHA-256:
  `705a08b903fecb9457a6c888040b16ff20be4bc74682ee3896c61cb27ce43060`.
- A freshly downloaded 0.163.0 control reproduced the archive/schema hashes
  recorded above. Both ordinary and `--experimental` schemas were compared.

No existing request method or definition was removed, and no required field was
added to an existing request. Ordinary request methods increase from 105 to 106
(`feedback/save`); experimental methods increase from 172 to 175 (also
`thread/sample` and `thread/sample/cancel`). Other additions include application
storage requirements, pre/post-model-request hooks, optional MCP tool-list
metadata, and `sci`/`sci_plus` plan enum values. Experimental turn requests gain
an optional client-metadata patch; prediction forks gain an optional MCP flag.

This is **not an entirely additive response change**: `imageGeneration` now
accepts either `fileId` or inline `result`, and adds optional `inputImages`.
AgentFleets' current `sanitizeThreadItem` returns `null` for both old inline and
new file-backed generated-image fixtures. Thus this is an existing generated
image display gap, not a newly broken supported display path. The image-input
test below verifies uploaded images, not generated-image rendering. Supporting
file-backed generated images requires attachment retrieval and panel rendering
work with separate regression coverage.

Ordinary realtime definitions are unchanged. The experimental
`ThreadRealtimeStartParams` gains only optional `voiceSessionId`, distinct from
the existing `realtimeSessionId`. Existing voice choices and requests remain
schema-compatible; an actual microphone/backend call was not tested.

### Execution and regression results

All runtime probes used temporary homes and synthetic sessions, without account
credentials, real model requests or existing user sessions. The image turn used
a local HTTP Responses fixture. Tests exercised the actual 0.164.0 executable.

- Production `validateRuntime`: exact version/schema, initialize/initialized,
  config/read and empty thread/list passed.
- Production `probeCodeModeHost`: protocol-v1 session open and no-tool arithmetic
  execution passed. `checkSandbox`: project write succeeded and outside-project
  write was blocked.
- Native test group: **12/12 passed, none skipped**, comprising 7 real-runtime
  cases and 5 daemon-discovery/transport guard cases. Files: `writer-native`,
  `conversation-history-native`, `image-native`, `session-daemon-native`,
  `daemon-transport`, and `app-server-config`. Coverage includes legacy/paginated
  writer exclusion, same-ID release/resume, permission profiles, archive/restore,
  descendant deletion protections, unrelated-history retention, Desktop config
  overrides, and attaching to an existing isolated daemon without stopping it.
- Local-agent regression group: **85/85 passed, none skipped** (`app-server-policy`,
  `managed-runtime-update`, `schema-01540`, `native-voice`, `codex-gap`,
  `conversation-history`, `images`, `session-app-server`, `daemon-app-server`,
  `update-network`). Control-plane group: **31/31 passed, none skipped**
  (`runtime-promotion`, `runtime-channel-api`, `native-voice`, `session-history`,
  `images`, `provider-runtime-policy`). Both TypeScript builds passed on Node 24.
- The first native attempt correctly refused the executable under `/tmp` because
  a root service requires every executable parent to be root-controlled. The
  verified executable was copied into a private root-owned directory, then the
  entire native group passed. No path-ownership guard was disabled.

macOS/Windows archive integrity was verified; those binaries were not executed.
Real-account MCP authentication, Windows enterprise proxy authentication and
live voice remain outside this Linux verification.

### Required upgrade work and current gate

An isolated run of the existing promoter with official 0.164.0 metadata confirmed
that it stops before artifact preparation. The current schema lookup returns
`unreviewed`, and `supportsNativeVoice("0.164.0")` returns false. Installing the CLI
alone therefore does not complete AgentFleets support.

To ship support, register the reviewed hash in **both** compatibility lists, add
0.164.0 to the native-voice gate with regression coverage, and release the matching
Agent/control plane. Preserve unknown-version rejection, host idle/local health
checks and rollback. The 0.154.0 bundled installer baseline is separate from the
reviewed managed-update channel; it need not be mechanically replaced to promote
0.164.0. Production preparation/publication must follow release provenance rules.

### User-facing changes from 0.163.0

The official release lists ten reusable `/presets` slots; inline `/model` and
`/permissions` arguments; fullscreen terminal image previews on Kitty/Sixel;
enterprise MCP sign-in improvements; credential masking for supported remote
Bash/Zsh sessions and custom providers; and a default-enabled Bedrock setup wizard.
These CLI features do not automatically become AgentFleets web controls.

Relevant fixes include failed/background compaction recovery, compressed-history
resume and preservation of saved thread settings, Windows Negotiate/NTLM proxy
authentication, config overrides across subcommand levels, prompts waiting for
pending permission selection, sandbox path/symlink hardening, installation/cache/
daemon-log cleanup, and embedded JavaScript Array.sort safety checks.

## Codex 0.164.0 implementation — Agent 0.30.149 (2026-10-26)

Following the pre-upgrade assessment, 0.164.0 is now registered in both reviewed
schema lists and in the compatible native-voice gate. Unknown patch versions
remain rejected. The bundled 0.154.0 installer baseline is unchanged; the managed
runtime channel discovers and validates 0.164.0 separately. A complete isolated
run of the production promoter passed official downloads, four-platform digest
checks, the exact schema, native handshake/history/config probes and Code Mode
execution, producing a 0.164.0 target in a disposable directory, not the live
channel. Hosts still require the normal administrator confirmation, idle-time
validation and rollback health acknowledgement.

Generated image items now appear directly in the conversation at a readable
size, with optional enlargement and original-image download. Started/completed
notifications keep the same item identity, including after history replay.
Generating, failed, unavailable and cloud-cleared states remain visible.

The adapter handles both inline `result` and `fileId` items. The official
0.164.0 implementation saves a native artifact before emitting the file reference:
`CODEX_HOME/generated_images/<thread>/<call>.png`. See the pinned upstream
[artifact layout](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/image-generation/src/artifact.rs),
[save/upload order](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/image-generation/src/tool.rs)
and [app-server save root](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/extensions.rs).
There is no public app-server RPC resolving arbitrary cloud file IDs. The adapter
reads only the exact thread/item artifact and checks the native `savedPath` when
present; it does not fetch provider URLs or read arbitrary paths. Symlinks,
hardlinks, changed files, non-regular files and files over 8 MiB are refused.
An unavailable local artifact produces an unavailable image state, not a claim
that cloud-only file IDs were downloaded. Provider file IDs, prompts and local
paths are not included in the synchronized generated-image item.

Original PNG/JPEG/WebP bytes up to 8 MiB are synchronized without lossy resizing.
Uploaded/pasted input images retain their separate 128 KiB limit. Generated
images reuse owner-bound cloud image storage, the 50 MB per-host quota, project
content policy, retention and cleanup tombstones. A refresh can display the
stored image while the host is offline. Clearing cloud images cannot be undone
by replaying native history. Image loading is ordered before turn completion;
RPC responses remain unblocked while reading native artifacts.

Validation: 37 local-agent tests (including opt-in real 0.164.0 runtime tests),
37 control-plane tests and 84 web tests passed, none skipped. These cover original
bytes larger than the input limit, exact artifact binding and unsafe paths,
file-reference precedence, real persisted inline/file-backed history across a
native process restart, event ordering, legacy/paginated history readers,
owner/machine isolation, cleanup replay, state rendering and unchanged runtime
gates. TypeScript checks passed. Chromium exercised the actual Timeline at
1280px and 390px widths: inline images decoded, no mobile horizontal overflow,
enlargement/Escape worked, the original PNG downloaded, and reload rendered it
again. The browser used synthetic data; no paid image generation or real account
request was made. macOS/Windows execution and live voice remain unverified.

Release mode must be `full` because the adapter, control plane and web UI change
together. This implementation record does not assert that a build was published.
