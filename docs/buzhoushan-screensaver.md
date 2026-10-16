# Buzhoushan broadcast screensaver

A purely visual idle effect for the Buzhoushan theme, meant for the captured broadcast window
(Live Companion, including the `AgentFleets-Broadcast.cmd` launcher window). It is not a lock
screen and must never affect calls, live messages, tasks or any other function.

## Behaviour
- Appears after 30 s (10–600 s, configurable) without mouse, keyboard, wheel or touch input.
  Speech never ends it. Any such input ends it immediately.
- Click-through (`pointer-events: none`) and covers only the central workspace (`.app-shell`),
  not the side introduction rails of the 16:9 canvas.
- Shows task state (counts only, never command text) while a turn runs, otherwise "待命中".
- Toolbar **屏保测试** previews at once: keys `1`–`9` or `←/→` switch effects, a click or any other
  key exits, pointer movement drives the effects, and a diagnostic line reports fps, canvas
  size/DPR, quality tier, renderer (software rendering is called out) and voice-link state.
- Settings live in "直播采集设置 → 空闲屏保特效" (browser `localStorage`, per browser profile; the
  launcher window uses its own profile): on/off, effect (auto-rotate every 45 s or fixed), quality
  (auto steps down below ~40 fps), idle seconds.

## Effects (`apps/web/src/lib/buzhoushan-effects*.ts`)
1 particle gravity field · 2 fluid smoke · 3 digital rain (Latin/digits/symbols only) ·
4 Lorenz attractor · 5 wave grid · 6 starfield · 7 three-body suns · 8 proton · 9 glyph ripples.
Each is a headless model class (unit-tested) plus a thin canvas wrapper. Drawing is in CSS pixels
over a device-pixel backing store, capped per quality tier.

## Voice reactivity (`lib/voice-signal.ts`)
While any `NativeVoicePanel` call (global coordinator or session voice) is connected, read-only
`AnalyserNode`s tap the microphone stream and the AI's remote stream. They are **never** routed to
an output, only level/pitch/onset numbers are computed in memory, and nothing is recorded, stored
or sent. Onsets act like clicks: broadcaster = blue and lower half, AI = green and upper half,
x follows pitch; while the AI is audible the microphone response is damped (speaker echo).
Taps are owned by the panel that attached them, so one panel unmounting cannot cut another's call.
Effects react as: glyph rings, particle kicks, fluid bursts, wave ripples, starfield surge,
matrix/proton boost, attractor shock + spin, three-body kick + shock ring.
The preview plays a synthetic voice when no call is connected.

## Voice-call screensaver ("声纹模式")
- When the **global voice coordinator** connects, `NativeVoicePanel` tucks away both of its windows
  once per call (the call window and the outer "语音总控" window; recovery never re-collapses them;
  session voice keeps its window). The floating "总控通话控制" button brings them back.
- The screensaver then enters automatically (setting "总控语音连接成功后自动进入声纹屏保", on by
  default, and only when the screensaver itself is enabled). In this mode **only a click or a key
  press leaves it** (mouse movement does not); hanging up leaves it too. `←/→` (or the faint on-screen
  arrows) switch between the existing effects instead of exiting; every call starts with 字符涟漪.
- The toolbar button changes with the call: without a call it is **屏保测试** (preview of the idle
  screensaver); while a call is connected it becomes **声纹屏保** and raises the voice screensaver
  immediately (no idle wait), at the style last used in this call, with the same exit rules.
- The caption shows the call state: 语音总控 连接中… / 已连接 · 聆听中 / 你在说话 / AI 在说话 / 已静音
  (`lib/voice-status.ts`, published by `NativeVoicePanel`, owner-scoped like the audio taps).

## Verifying changes
- `npm run build` in `apps/web` (real `tsc -b`) and `NODE_ENV=test npx vitest run`.
- `css-integrity.test.mjs` guards the stylesheets against unbalanced braces.
- Headless Chrome screenshots of a small harness are useful for visuals, but they do not load the
  app CSS and have no GPU; verify served assets after deployment and check the preview diagnostics
  on the real Windows machine.
