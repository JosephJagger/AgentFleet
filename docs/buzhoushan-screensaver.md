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
  plays a synthetic voice so the voice reaction can be seen. It looks the same as any other screensaver: there
  is no diagnostic text on screen.

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
memory, and nothing is recorded, stored or sent. Taps are owned by the panel that attached them, so one panel
unmounting cannot cut another's call.

- An **onset** (each word or stress, a "click") fires when the level jumps above its slow average: floor 0.012,
  threshold avg×1.35+0.006, 140 ms cooldown, strength 0.45–1. The first sample only primes the average.
  You are blue and in the lower half, the AI is green and in the upper half, x follows pitch; while the AI is
  audible the microphone response is damped (speaker echo).
- The continuous **level** is RMS×5 (0..1). Both are multiplied by the **声音灵敏度** setting (0.5–3×, default 1,
  in 屏保设置): a higher value reacts to quieter sound.
- Reactions per onset: glyph rings; particle kicks; fluid dye bursts; wave-grid ripples; attractor spin + shock
  front; three-body push on the nearest sun + shock ring; **digital rain** columns around the pitch surge and
  light up in the speaker's colour (idle columns restart at the top); **starfield** warp punch + ring;
  **proton** fizz of extra quark pairs, swollen quarks + ring. Level also speeds the rain, starfield, proton
  and attractor, and speeds/swells the three-body system.
- The settings popover styles its checkboxes inline and sliders unframed (`.buzhou-broadcast-editor`).

## Verifying changes
- `npm run build` in `apps/web` (real `tsc -b`) and `NODE_ENV=test npx vitest run`.
- `css-integrity.test.mjs` guards the stylesheets against unbalanced braces.
- Headless Chrome screenshots of a small harness are useful for visuals, but they do not load the app CSS and
  have no GPU; verify served assets after deployment and judge frame rate and sharpness on the real Windows machine.
