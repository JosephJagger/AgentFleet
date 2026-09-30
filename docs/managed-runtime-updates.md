# 托管 Codex 自动升级

托管模式会自动检查 Codex 稳定版。通过兼容性检查后，各主机在空闲时更新；更新失败时保留回退能力。用户无需在宿主机上手工运行 Codex 来检查兼容性。

尚未适配的版本不会自动晋升。遇到这种情况，继续使用当前版本，等待 AgentFleet 发布支持更新即可。桌面版与托管 Codex 不要求版本号相同。

自行部署时，请按项目安装说明启动配套服务。Codex 的自动升级不代表 AgentFleet 本身也会自动更新；需要新版兼容支持时，先更新 AgentFleet。

## 手动刷新模型列表

Agent 0.30.51 起，主机 → 高级维护工具 → 重新扫描，会明确重新调用原生 model/list，读取全部分页，并将模型和插件目录重新上报。刷新通过只读目录连接完成，不会重启正在执行任务的会话。扫描项目历史需要多轮时，模型列表只刷新一次。

失败会报告“模型列表刷新失败”，保留最近成功目录和其更新时间，并标记错误；不会把失败当成成功刷新。Codex 0.158.0 的 model/list 没有强制清除缓存参数，因此刷新后仍不出现新模型时，需要进一步核对原生缓存、版本及账号可用范围，不能保证新发布模型立即可选。

From Agent 0.30.51, **Host → Advanced maintenance tools → Rescan** explicitly rereads the native model catalog, including pagination, and republishes it. It uses the catalog reader without restarting active session writers. Failure preserves the last successful catalog and timestamp with an explicit error. This reread does not guarantee bypassing Codex's internal model cache.

### Agent 0.30.52 发布清单修复

0.30.51 发布清单中的 JSON 空格导致 POSIX 安装器解析失败，已失败主机会暂停同一版本。0.30.52 使用兼容清单并保留 0.30.51 的模型刷新修复，让主机在空闲时自动重试新版本。发布前必须运行 `node packaging/validate-release-manifest.mjs <manifest.json>`，它实际执行 Linux/macOS 安装器的字段解析。

Agent 0.30.52 corrects the release manifest formatting and retains the model refresh fix. Hosts that paused the failed 0.30.51 update can retry the new version when idle. Release validation now exercises the POSIX installer parsers before publishing.

### Codex 0.159.0 托管适配

0.159.0 官方稳定版的 App Server v2 协议哈希为 `81a88c04ae4984b16d73080f4109d0477682bc76c8adbe483e371175ce54c054`。相对 0.158.0，新增可选的历史项目游标形式、MCP 服务筛选项和错误类型；已有的字符串游标与 AgentFleet 使用的请求保持有效。通过隔离环境的版本、协议、启动、配置和会话列表测试后，由托管验证器再次核验四个平台官方文件及 Code Mode，再晋升目标。主机只在空闲时应用。

Codex 0.159.0 adds optional protocol fields while retaining the string history cursor used by AgentFleet. The managed validator verifies official artifacts and a sandboxed App Server smoke test before promotion; hosts apply the target when idle.

0.159.2 是随后发布的稳定修订版；其 App Server v2 schema 哈希与 0.159.0 完全相同，也已完成官方文件摘要和隔离启动验证。托管验证器因此优先晋升 0.159.2。

Codex 0.159.2 is the subsequent stable patch with the same App Server v2 schema hash as 0.159.0. The managed validator targets this later stable release.
