# 主机 SSH 互通

Linux 主机上已经存在的 SSH 账号与密钥，在面板「主机 → SSH 互通」登记后，同一工作区内其他 Linux 主机上的 Agent 即可 `ssh af-<名称>` 直接操作该主机。面板不生成、不安装密钥。

## 流程

1. 管理员登记账号（名称、加密方式、口令、私钥、公钥、用户名、地址、端口、描述、可访问主机）。
   - 私钥与口令以 AES-256-GCM 加密存储（`ssh-access.key` 位于数据库旁，0600），API 永不回显。
   - OpenSSH 私钥自带公钥：公钥可留空自动提取；不匹配、类型不一致、加密私钥缺口令都会在保存时拒绝。
2. 控制面让**被访问主机**自检（`ssh.request action=inspect`）：账号是否存在、公钥是否在 `authorized_keys`、上报 `/etc/ssh/ssh_host_*_key.pub`、sshd 端口与候选 IP。主机指纹因此经受信通道固定，地址留空时使用上报的 IP。
3. 控制面向每台可访问的 Linux 主机下发**完整期望状态**（`action=sync`）。主机连接服务：
   - 写入 `~/.ssh/agentfleet/`：`config`、`known_hosts`（按 `HostKeyAlias` 固定）、`keys/<别名>`（0600，带口令的私钥会去掉口令，因为 Agent 无法交互输入）、`HOSTS.md`、`state.json`；
   - 在 `~/.ssh/config` 顶部插入一行带标记的 `Include`；
   - 用 `ssh-keygen -y` 核对私钥与公钥，逐账号回报结果；
   - 期望状态为空时删除托管目录和 `Include`。
   主机重连完成对账、账号增删改、主机移除时都会重新下发。
4. Agent 感知：Claude 会话通过 `systemPrompt.append`、Codex 新线程通过 `developerInstructions` 注入可访问主机列表；其他 Agent 可读取 `~/.ssh/agentfleet/HOSTS.md`。
5. 「测试连接」让每台可访问主机执行 `ssh -o BatchMode=yes af-<名称> true`。

## 约束与已知限制

- 仅 Linux（`machines.platform` 为 linux/ubuntu）；旧版连接服务不上报 `capabilities.sshAccess`，不会收到任何 SSH 帧。
- 主机指纹未上报时退回 `StrictHostKeyChecking accept-new`，并在界面标注「指纹未固定」。
- Codex 默认沙箱禁止网络，`ssh` 需经审批提升执行。
- 风险：任一可访问主机被攻破即可登录目标账号。请使用专用非 root 账号，并用「可访问主机」收窄范围。

## 后续

- 托管 `ssh-agent`，私钥只进内存不落盘。
- 主机互不可达时经面板中转执行（`fleet_exec`）。
- 由面板签发短期 SSH 证书。
