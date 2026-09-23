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
