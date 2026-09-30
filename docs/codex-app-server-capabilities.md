# Codex App Server 功能接入状态

核对基线：Codex **0.159.2**，2026-09-30。这里比较完整的原生能力与面板，而不是两个 Codex 版本之间的变化。

本批作为 **Agent 0.30.60** 的接入记录，**不代表全部缺口已经完成**。账号、平台和实验开关的限制仍以原生服务返回为准。

## 本批已补齐

入口：已接管的 Codex 会话 → 会话配置 → 更多工具 → **Codex 工具与账号**。

| 功能 | 可用操作和边界 |
|---|---|
| 官方账号与用量 | 读取登录状态、设备码登录、取消登录、退出；官方账号/会话用量单独显示，缺失数据不当作零，也不叠加到面板 token 统计。面板不接收认证文件。 |
| 重置卡 | 读取数量及原生可读详情；用户明确确认后使用，使用同一请求 ID 防止重试重复消费，随后刷新额度。与临时重置消息预测分开。 |
| 目标 | 读取、保存暂停目标、标记完成、调整预算、清除；管理恢复连接临时禁用目标自动继续，不修改全局配置。不允许通过管理入口激活目标绕过面板调度。 |
| 原生分组 | 列出、创建、重命名、删除、移动当前会话；不改变面板项目、目录或权限，删除分组保留会话。 |
| 原生附件 | 分页读取附件元信息；保存和移除面板备注。不会覆盖原生内部附件；备注不会自动成为下一轮上下文。 |
| 插件与应用 | 浏览插件市场、安装/卸载、同步、添加/移除/更新 GitHub 市场；读取已安装应用和工具说明。安装路径由原生市场清单解析。 |
| MCP | 授权、重载、工具/资源清单、读取清单中的资源、确认后调用清单中的工具；常规补充信息表单进入面板原有问题回答流程。敏感或不支持的表单明确转交宿主机。 |
| 历史分支 | 全部历史、指定原生 Turn 之前、截至指定 Turn；保留原会话，分支不会自动继续继承的目标。直接回退原会话尚未接入。 |
| 审阅 | 未提交修改、与目标分支比较、指定提交、自定义要求。 |
| 会话引用 | 为新会话注册受限引用读取工具；只读取本轮附上的引用文件，支持关键词和分页，不提前摘要。原生旧会话通过已有文件工具读取材料。 |
| 结构化输出 | 下一轮可配置受限 JSON Schema；无效结构阻止发送和排队，追加当前轮次不改变其输出格式。 |
| 原生文件与命令 | 项目内模糊搜索、目录浏览；独立命令沿用会话权限和目录，30 秒超时、有输出限制，不接受客户端指定环境变量或权限。不是交互终端。 |
| 原生状态 | 模型提供方能力、管理限制、工作区公告；Windows 沙箱只检查状态，其他平台返回不适用，不自动安装。 |
| 运行事件 | 模型路由、MCP 进度、Hook 状态和认证恢复；同一进度卡片合并更新，不上传原始 Hook 命令或认证错误。 |

修改默认环境登录、插件或配置可能影响该宿主机其他原生会话；必须明确确认，并等待面板管理的任务空闲。主机离线或会话未完成对账时，不接受写入操作。

管理请求以会话租约、主机、项目版本、原生 Thread、执行片段和当前 Turn 绑定。未确认结果保持阻塞，不能用重试绕过状态检查。原生账号额度消费、真实登录和外部工具写入没有在开发验证中执行。

## 已单独验证的实验能力

默认隐藏，需勾选 **显示已验证的 Codex 实验接口**。

- 记忆状态、本会话记忆开关、重置默认环境记忆。
- 当前会话原生文本搜索和时间轴分页。
- 原生队列读取、修改、删除、排序；只修改已有条目，不启动任务，不改变面板队列。修改前核对条目，排序必须包含完整队列。
- 运行中修改模型、推理强度、服务档位和推理摘要；只影响本轮后续步骤，不能切换计划模式，也不改变下一轮。原生要求启用 `step_model_switching`，保存开关后需要重新连接。
- 内容无关的进程诊断。

当前任务栏独立显示已确认的运行中设置；下一轮仍显示原设置，旧 Turn 的设置不能覆盖新 Turn。

## 验证方式

- 实际运行 0.159.2，使用临时 `CODEX_HOME`，不读取或复制现有账号凭据。
- 本地 Responses 模拟服务验证：本轮模型从原设置切到新设置，下一轮恢复原设置；原生动态工具回调能返回引用；输出 Schema 传到模型请求。
- 本地 MCP 模拟服务验证：原生清单、资源读取和工具调用。
- 本地目标验证发现 `active` 会自主连续运行；管理入口限制为暂停/完成，临时管理连接禁用该线程目标自动继续（不写全局配置）；另起进程恢复一个已保存的 active 目标后，可以读取并暂停目标，模型请求数仍为 0。
- 原生验证分组、备注、队列编辑、目录搜索与独立命令接口；两轮历史分支验证指定任务之前保留 0 轮、截至该任务保留 1 轮。
- 独立命令的本机原生执行验证使用临时目录和无副作用命令；受限项目策略另有转发和目录隔离测试，不能据此替代 Windows/macOS 原生沙箱验证。
- 自动测试覆盖跨会话拒绝、目录逃逸、符号链接、协议白名单、敏感表单、重复请求、并发任务阻塞、Schema 和当前/后续任务设置隔离。

本批自动测试：主机 259 项通过、6 项平台测试跳过；控制端 129 项通过；前端 416 项通过，共 804 项通过。三个项目构建通过。前端全量测试使用测试环境、限制并发数运行，以避免既有输入建议测试受 CPU 争抢影响。

Windows、macOS 原生宿主机验证，以及真实账号/组织特定功能验证，尚待完成。

## 后续缺口与接入顺序

1. **历史回退**：已在隔离会话中验证 `thread/revert` 能删除指定任务及后续历史，源分支保持原样；面板接入仍未完成。原生替换历史后，同步重建面板投影和引用内容版本，阻止旧内容重新出现；不能只加一个 `thread/revert` 按钮。
2. **原生队列新增/启动**：与面板队列统一执行权和项目互斥；不能直接启动第二个 Turn。
3. **交互终端与文件编辑**：终端生命周期、输入/取消/输出、文件写入冲突检测，与现有项目权限绑定。
4. **原生配置导入、技能额外目录、插件分享**：先提供预览、范围和明确确认，再写入；本批没有提供任意配置/RPC 穿透。
5. **实时音频、原生环境/远程控制、身份验证与设备证明**：分别进行账户、平台和传输验证；未通过的能力不放入“已验证实验接口”。
6. Windows 沙箱安装、其他登录方式、用户反馈上传等需要对应平台/账号验证。已有状态检查不等于安装或认证流程已完成。

## 协议覆盖附录

原生默认请求 104 个；含实验请求共 167 个。主机接入允许列表从 37 个扩展至 **83 个**：默认 69 个、实验 14 个。允许列表表示调用通道，**不是完整产品完成率**；例如文件接口没有任意写入，队列没有第二套独立启动入口。

以下保留所有尚未接入的客户端接口，避免把已有面板相似功能误称为接入完成。

### 默认协议尚未接入

- `account/gatewayOAuth/cancel`
- `account/gatewayOAuth/login`
- `account/gatewayOAuth/read`
- `account/sendAddCreditsNudgeEmail`
- `command/exec/resize`
- `command/exec/terminate`
- `command/exec/write`
- `config/batchWrite`
- `experimentalFeature/enablement/set`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`
- `externalAgentConfig/import/recordHistory`
- `feedback/upload`
- `fs/copy`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readFile`
- `fs/remove`
- `fs/unwatch`
- `fs/watch`
- `fs/writeFile`
- `plugin/installed`
- `plugin/share/checkout`
- `plugin/share/delete`
- `plugin/share/list`
- `plugin/share/save`
- `plugin/share/updateTargets`
- `skills/extraRoots/set`
- `thread/approveGuardianDeniedAction`
- `thread/inject_items`
- `thread/metadata/update`
- `thread/revert`
- `thread/shellCommand`
- `windowsSandbox/setupStart`

### 实验协议尚未接入

- `account/bedrock/discover`
- `account/bedrock/setup`
- `environment/add`
- `environment/info`
- `environment/status`
- `fuzzyFileSearch/sessionStart`
- `fuzzyFileSearch/sessionStop`
- `fuzzyFileSearch/sessionUpdate`
- `mcpServer/event/stream/start`
- `mcpServer/event/stream/stop`
- `mock/experimentalMethod`
- `plugin/search`
- `process/kill`
- `process/resizePty`
- `process/spawn`
- `process/writeStdin`
- `project/create`
- `project/delete`
- `project/import`
- `project/list`
- `project/move`
- `project/read`
- `project/update`
- `remoteControl/client/list`
- `remoteControl/client/revoke`
- `remoteControl/disable`
- `remoteControl/enable`
- `remoteControl/pairing/start`
- `remoteControl/pairing/status`
- `remoteControl/status/read`
- `rollout/compress`
- `thread/backgroundTerminals/terminate`
- `thread/decrement_elicitation`
- `thread/increment_elicitation`
- `thread/queue/add`
- `thread/queue/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendSpeech`
- `thread/realtime/appendText`
- `thread/realtime/listVoices`
- `thread/realtime/start`
- `thread/realtime/stop`
- `thread/search`
- `thread/settings/update`
- `userVerification/cancel`
- `userVerification/delete`
- `userVerification/enroll`
- `userVerification/status`
- `userVerification/verify`

### 服务端请求的剩余边界

`account/chatgptAuthTokens/refresh` 适用于客户端提供外部认证令牌的模式，本面板仍使用原生认证，不接收令牌；`attestation/generate` 不能由浏览器伪造宿主机证明。未支持的请求明确拒绝。`currentTime/read` 只为已验证的托管会话返回主机 Unix 时间。

官方协议说明：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。精确字段以 0.159.2 实际生成的默认及实验 Schema 为准。
