# Claude Code 宿主机接入

主机名称旁的 Agent 选择器默认使用 Codex。宿主机连接服务报告 Claude Code 已安装后，可切换到该主机的 Claude 项目与会话；未安装时选项禁用。Agent 选择按主机保存于当前页面状态。会话链接会自动选择对应 Agent。

Codex 保持原来的 SessionAppServer 路径。Claude 使用官方 `@anthropic-ai/claude-agent-sdk` 0.3.285，通过 stdio 启动宿主机已有 CLI；浏览器继续使用 agentfleets 的控制服务。没有新增 Claude 登录、令牌上传或凭据复制。连接服务必须以已登录 Claude 的宿主机用户运行，并保留该用户的 HOME / CLAUDE_CONFIG_DIR。模型与项目配置读取宿主机配置，权限采用 default 模式及宿主机规则，需确认的工具调用和用户提问通过面板响应。

原生 session UUID 在控制服务中使用 `claude_` 前缀。项目 provider、项目 ID 和 identityHash 隔离，即使 Codex 与 Claude 指向相同目录也不会混用项目与会话。数据库版本 40 为已有项目补充默认 codex provider。历史通过官方 listSessions / getSessionInfo / getSessionMessages 获取，恢复使用原 UUID 的 resume；丢失原会话时明确失败，不创建替代上下文。历史目录变更会触发目录刷新，并保留定期校验。

当前支持历史查看、原会话接管与释放、新会话、消息与图片/文件附件、后续轮次排队、取消、审批和用户提问。Claude 不复用 Codex 模型选择、插件配置或原生维护命令；未适配的操作在前后端同时禁用。进程结束确认后才释放执行连接。恢复失败和无法证明结果的情况继续沿用既有冻结机制。

官方 SDK 无法附着到已运行的交互终端进程。先退出该目录下的 Claude 终端即可通过面板继续原会话。Linux 与 macOS 校验进程工作目录；Windows 无法可靠读取其他进程的 cwd，因此发现其他 Claude 原生进程时保守阻止新写入。不会强杀用户进程。该行为是历史与上下文恢复，不是终端进程迁移。

发布时 SEA 构建为 SDK 的 import.meta.url 提供模块路径，便携包携带 SDK JavaScript 包，执行始终指定宿主机 Claude CLI，不依赖 SDK 自带的可选二进制。

验证包含 provider 目录隔离、选择器安装状态、首条流式消息、原 UUID 恢复、权限审批、用户提问、缺失会话失败和本机真实恢复。真实验证已使用宿主机 2.1.285：先发送标记，再恢复相同会话询问标记，返回正确标记。

## 工具归属、历史与用量

会话入口、快捷访问与会话标题统一显示「主机 · Agent · 项目」。回复作者按会话 provider 显示。主机用量查询按 provider 隔离；项目和会话由服务端的归属确定 provider，不能用客户端参数把 Claude 数据变成 Codex 数据。Agent 0.30.58 起，Claude 账号额度通过宿主机官方 SDK 的 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` 查询原生 `/usage` 数据：5 小时、7 天、模型专属窗口与重置时间。每分钟最多查询一次，输入流不发送用户消息，不启动模型推理；仅上传经过字段白名单过滤的额度快照，不上传凭据。该接口官方标为实验性，旧 CLI、不适用订阅、超时和失败会显示不可用或过期；不回退到 Codex 额度。额外付费点数未映射为 Codex 点数。token 使用 Claude 原生 result 的会话累计 modelUsage 与本次 query usage；已记录值只计可证明的增量。

历史继续以官方 SDK 的 parentUuid 对话链为准，保留原始文件时间用于显示，时间不决定顺序。历史顺序元数据单独同步，可纠正实时回复先到、用户消息随后补同步的顺序，并用原生 item ID 合并重复回复；不修改原生会话或既有事件日志。

Agent 0.30.57 起，「＋」保留图片、文件、文件夹、会话引用与目标，并提供 Claude 原生计划模式。独立模型与 effort 控件使用 SDK 的 model、effort、permissionMode，不查询 Codex catalog。/model、/effort、/plan 由面板映射到上述原生能力，/help 显示已接入能力；其他尚未适配的终端命令明确提示在主机使用，不作为普通聊天消息发送。宿主机已有 skills、plugins 与 MCP 使用 Claude 自身 settingSources 加载。优化表达仍使用独立的表达优化 API。

Agent 0.30.58 使用 `supportedModels()` 读取宿主机原生模型目录及每个模型的 effort 支持；选择列表展示原生版本名称，并发送 resolvedModel 完整 ID。Claude Code 设置入口打开模型、思考强度和计划模式对话框，应用于下一轮消息。

移动端输入建议与桌面共用浮层，定位在输入区与模型快捷入口上方，不占 composer 高度。监听 visualViewport 的缩放和滚动，避免键盘出现或建议切换时撑高输入框。Claude 模型快捷入口采用与 Codex 相同的小字样式，配置在独立弹窗中完成。

Agent 0.30.59 起支持 Claude 原生 default / auto / acceptEdits / dontAsk 权限模式。可选值来自宿主机 CLI --help，auto 选项还按原生模型 supportsAutoMode 判断。SDK permissionMode 在新轮次生效，plan 始终优先；原生 canUseTool 和 AskUserQuestion 继续处理仍需响应的操作。模型、effort、权限和计划模式在弹窗点击“保存”后按工作区和会话保存在控制面数据库；切换、刷新和换设备均重新读取。取消不改变已保存配置，版本冲突要求重新读取，读取失败不会回退继承并发送。未选择权限时保持 default。尚未更新的 Agent 不允许收到权限字段。

Claude 回复中明确的行内代码文件路径、正文绝对路径与 Markdown 文件链接提供预览和下载按钮；沿用 /api/sessions/:id/files 和 projectFiles 原生传输。命令代码块、目录和远程 URL 不自动转成宿主机文件动作，复制回复保留原文。文件读取继续限制于该已接管会话的项目和在线宿主机。
