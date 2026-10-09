# October 2026 / 2026 年 10 月上线汇总

Reviewed on 2026-10-09 against deployed panel build `4ff482d`, database schema 54 and published Agent 0.30.91. This is a feature summary, not a promise that every host is upgraded. Features follow host/provider capabilities.

| Feature / 功能 | Entry / 入口 | Evidence / 范围说明 |
| --- | --- | --- |
| Cross-host/project/session voice coordination / 跨主机项目会话语音总控 | Top toolbar / 顶部语音总控 | [Status and parallel projects](panel-voice-status.md): distinct projects can run concurrently; same-project/session admission remains protected. |
| Live progress and in-turn instructions / 过程与本轮追加 | Session progress; voice or composer / 会话进度、语音或输入框 | [Native progress](live-session-progress.md): available events and bounded output, not an invented percentage. Steer binds the exact running turn. |
| Persistent to-dos and results / 持久待办与结果 | Voice → task records / 语音总控 → 待办与结果记录 | [Task records](panel-voice-status.md): saved intent survives calls; recovery does not authorize execution. Unsaved/lost audio is not recoverable. |
| Read-only session history / 只读会话历史 | Ask voice for a precise session / 向总控指定会话查询 | [History](voice-session-history.md): original dialogue including typed sessions; partial/offline/deleted states remain explicit. |
| Long-term voice preferences / 长期语音偏好 | Settings / 设置 | [Preferences](voice-long-term-preferences.md): explicit rules, user isolation, bounded storage; reconnect to clear changed old context. Not general memory for text workers. |
| Claude Code | Agent selector beside host / 主机旁 Agent 选择器 | [Claude support](claude-code.md): native CLI/account, original-session continuation, attachments and approvals. No claim of full Codex parity. |
| Conditional reset signals / 有条件重置预测 | Host quota / 主机额度区 | [Reset feed](reset-radar.md): hourly collection, rolling seven-day paginated source history; prediction validity is separate from history retention. |
| Reset-card expiry / 重置卡有效期 | Host account tools / 主机账号与工具 | Native expiry is displayed in UTC and Beijing time; missing expiry is not guessed. |
| Shared settings and voices / 统一默认与音色 | Settings → Codex configuration / 设置 → Codex 配置 | [Settings](codex-settings.md), [voice choices](voice-settings.md): host-supported catalogs and scoped overrides. |
| Managed version cleanup / 托管版本清理 | Hosts → Attachments and versions / 主机 → 附件和版本 | [Cleanup](version-cleanup.md): protects active/referenced versions and rollback; no arbitrary application-directory deletion. |
| Protected publication / 通话保护发布 | Operator safe publisher / 运维安全发布流程 | [Voice-safe deployment](voice-safe-deployment.md): wait for calls to finish, defer on timeout; no guarantee against network or host failure. |

## What to expect / 使用前提

- Use compatible online hosts with working native authentication. Voice is experimental and requires HTTPS and microphone permission. Closing/backgrounding a page can end a call; dispatched tasks continue.
- Full recent voice integration uses Agent 0.30.90+ (0.30.91 includes reset-card display improvements); managed Codex 0.160.1 was validated. History target reads require 0.30.89+; older hosts may provide only synchronized history.
- Claims are scoped to supported interfaces, not every native feature. No Codex Cloud or dots integration is claimed. Marketing languages do not expand the console's English/Chinese language support.
- 执行位置、权限、原生账号与额度保持各自归属。不会池化订阅额度，不会因为恢复历史记录而重新执行任务。预测不能代替原生实际额度与重置日期。

## Delivery / 交付范围

The public repository is synchronized with these already deployed implementations alongside the bilingual README refresh. The product website is published independently; updating it does not restart the console, connected hosts or voice calls. Existing installations must follow the documented safe panel/Agent update flows to obtain new code.
