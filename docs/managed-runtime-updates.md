# 托管 Codex 自动升级

托管模式会自动检查 Codex 稳定版。通过兼容性检查后，各主机在空闲时更新；更新失败时保留回退能力。用户无需在宿主机上手工运行 Codex 来检查兼容性。

尚未适配的版本不会自动晋升。遇到这种情况，继续使用当前版本，等待 AgentFleet 发布支持更新即可。桌面版与托管 Codex 不要求版本号相同。

自行部署时，请按项目安装说明启动配套服务。Codex 的自动升级不代表 AgentFleet 本身也会自动更新；需要新版兼容支持时，先更新 AgentFleet。

## 手动刷新模型列表

Agent 0.30.51 起，主机 → 高级维护工具 → 重新扫描，会明确重新调用原生 model/list，读取全部分页，并将模型和插件目录重新上报。刷新通过只读目录连接完成，不会重启正在执行任务的会话。扫描项目历史需要多轮时，模型列表只刷新一次。

失败会报告“模型列表刷新失败”，保留最近成功目录和其更新时间，并标记错误；不会把失败当成成功刷新。Codex 0.158.0 的 model/list 没有强制清除缓存参数，因此刷新后仍不出现新模型时，需要进一步核对原生缓存、版本及账号可用范围，不能保证新发布模型立即可选。

From Agent 0.30.51, **Host → Advanced maintenance tools → Rescan** explicitly rereads the native model catalog, including pagination, and republishes it. It uses the catalog reader without restarting active session writers. Failure preserves the last successful catalog and timestamp with an explicit error. This reread does not guarantee bypassing Codex's internal model cache.
