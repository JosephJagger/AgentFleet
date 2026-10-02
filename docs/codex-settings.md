# Codex 配置 / Codex settings

在「设置 → Codex 配置」中管理统一默认、主机与项目例外，以及原生工具与账号。会话中的运行配置和执行权限仍可单独修改。

每个运行配置项按以下顺序继承：会话 → 项目 → 主机 → 当前工作区统一默认 → Codex 原生配置。「继承上级」只清除此项覆盖；「使用原生值」跳过上级值，交给原生环境决定。服务档位的「恢复默认档位」会向原生发送明确的清除操作，与继承不同。权限独立继承，完全访问需要明确确认。

新配置在提交下一任务时解析。已提交的排队任务、运行中任务和重复提交的同一请求保留原配置。目标主机不支持所选模型或参数时会拒绝提交，不会自动更换模型。仅配置推理强度等选项而没有模型时，需要已有会话上报的原生模型；未上报时应先指定模型。

原生账号、额度、插件市场、MCP 授权与技能开关可在设置中直接选择主机管理，无需会话；变更仅作用于该主机默认 Codex 环境，不会跨主机复制账号或密钥。目标、附件、队列和项目 MCP 工具调用仍需要明确选择会话。只查看菜单不会执行操作。主机有任务、审批或通话时拒绝环境变更；操作中断后不自动重试。需要连接服务 0.30.72 或更新版本。

## Compatibility

Manage defaults under **Settings → Codex settings**. Each field independently resolves **session → project → host → workspace → native Codex**. Permission defaults remain separate from model settings. Full access still requires explicit confirmation.

**Inherit from parent** removes a field override. **Use native value** stops inheritance without sending a runtime override. An explicit default service-tier reset sends `null`, preserving the native reset semantics. Model options come from host catalogs; task submissions validate the resolved combination against the target host. Unsupported combinations fail visibly instead of silently switching models.

Settings are resolved when a task is submitted. Running tasks, already queued tasks, and idempotent retries retain their accepted configuration. Host account, quota, plugin marketplace, MCP authorization and skill settings require only a selected host (Agent 0.30.72+). Goals, attachments, queues and project MCP tools still require a managed session. Opening Settings never claims sessions or creates tasks. Environment mutations are blocked during host tasks, approvals and calls; interrupted operations are not automatically replayed. Credentials are never copied between hosts.

Schema 45 adds workspace defaults and field overrides. Existing whole-group preferences preserve omitted fields as native values, so adding a global default does not silently change old overrides. Users can restore individual fields to inheritance. This changes the control plane and web UI only; the Agent wire format is unchanged. Before deployment, back up the database. Older control-plane binaries cannot open schema 45; do not roll them back against a migrated database.

Schema 46 extends durable host operation receipts for native management and preserves existing receipts. Back up before deployment; older control-plane binaries cannot open schema 46.
