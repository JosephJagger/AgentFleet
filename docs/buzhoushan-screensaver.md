# Buzhoushan broadcast screensaver

One purely visual screensaver for the Buzhoushan theme (desktop layout), meant for the captured broadcast
window (Live Companion, including the `AgentFleets-Broadcast.cmd` launcher window). It is not a lock screen
and must never affect calls, live messages, tasks or any other function. Other themes do not have it.

## One screensaver, three ways in
- **Idle**: after 30 s (10–600 s, configurable) without mouse, keyboard, wheel or touch input.
- **Voice call**: when the **global voice coordinator** connects, `NativeVoicePanel` tucks away both of its
  windows once per call (the call window and the outer "语音总控" window; recovery never re-collapses them;
  session voice keeps its window) and the screensaver starts at the glyph ripples (setting "总控语音连接成功后
  自动进入屏保", on by default, and only when the screensaver is enabled).
- **Toolbar button "屏保"**: raises it at once, with or without a call (also when disabled). With no call it
  plays a synthetic voice and shows a diagnostic line (fps, canvas size/DPR, quality tier, renderer; software
  rendering is called out).

## Behaviour
- Leaves **only on a click or a key press**; mouse movement does not leave it. A click or key raised it is
  ignored for 400 ms. Hanging up leaves a screensaver that the call itself raised; one raised by idling or by
  hand stays.
- `←/→` (or the faint on-screen arrows) switch effects instead of leaving. Order: 字符涟漪, 粒子, 烟雾,
  数字雨, 吸引子, 波浪网格, 星空, 三体, 质子. "Auto" mode (setting 屏保效果) rotates every 45 s unless a
  call is live or an effect was picked; a fixed effect never rotates.
- Click-through (`pointer-events: none`), and it covers only the central workspace (`.app-shell`), not the
  side introduction rails of the 16:9 canvas. The pointer drives the effects while it is up.
- One caption: task progress (counts only, never command text) or "待命中", plus the call state — 语音总控
  连接中… / 已连接 · 聆听中 / 你在说话 / AI 在说话 / 已静音 (`lib/voice-status.ts`, published by
  `NativeVoicePanel`, owner-scoped like the audio taps). A brief toast names the effect on each switch.
- Settings live in "直播采集设置 → 屏保设置" (browser `localStorage`, per browser profile; the launcher
  window uses its own profile): on/off, effect, quality (auto steps down below ~40 fps), idle seconds,
  automatic entry on call connect.

## Effects (`apps/web/src/lib/buzhoushan-effects*.ts`)
Each is a headless model class (unit-tested) plus a thin canvas wrapper. Drawing is in CSS pixels over a
device-pixel backing store, capped per quality tier.

## Voice reactivity (`lib/voice-signal.ts`)
While any `NativeVoicePanel` call is connected, read-only `AnalyserNode`s tap the microphone stream and the
AI's remote stream. They are **never** routed to an output, only level/pitch/onset numbers are computed in
memory, and nothing is recorded, stored or sent. Onsets act like clicks: broadcaster = blue and lower half,
AI = green and upper half, x follows pitch; while the AI is audible the microphone response is damped
(speaker echo). Taps are owned by the panel that attached them, so one panel unmounting cannot cut another's
call. Every effect reacts: glyph rings, particle kicks, fluid bursts, wave ripples, starfield surge,
matrix/proton boost, attractor shock + spin, three-body kick + shock ring.

## Verifying changes
- `npm run build` in `apps/web` (real `tsc -b`) and `NODE_ENV=test npx vitest run`.
- `css-integrity.test.mjs` guards the stylesheets against unbalanced braces.
- Headless Chrome screenshots of a small harness are useful for visuals, but they do not load the app CSS and
  have no GPU; verify served assets after deployment and check the diagnostic line on the real Windows machine.
