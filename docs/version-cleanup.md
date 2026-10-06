# 附件和版本 / Attachments and versions

主机页的「附件存储」现为「附件和版本」。展开「版本清理」，点击「检查版本」可查看占用、可释放空间及保留原因；有可清理内容时，点击「一键清理旧版本」。这不会清理项目、会话、账号或附件。

Agent 0.30.74 起，新安装、修复或升级后的连接服务恢复健康连接，且任务和通话空闲时，会自动检查并清理旧版本。不需要手动执行安装脚本中的清理命令。正常情况下保留当前版和一个回退版；正在运行、进程/容器或本地状态仍引用的旧文件也会保留，因此可能看到超过两个版本。离线主机会在恢复连接后处理。

清理范围仅限 AgentFleets 管理的版本目录、托管 Codex releases 和旧升级备份。不会清理自装 Codex。安装不足一小时的目录延后处理；有这类目录时一小时后重查，否则每日复查。无法获取运行引用、安装状态不明、正在升级或目录包含链接时，不冒险删除。手动清理期间暂停接收新任务；已有任务或通话时拒绝清理。中断的删除不会自动重放，需重新检查实际结果。

显示空间是文件长度汇总，压缩、稀疏文件和共享文件可能使实际磁盘释放量不同。明细最多展示 100 项，合计包含全部受管目录。旧连接服务需先升级，才能检查和清理。

## English

Under **Hosts → Attachments and versions → Version cleanup**, check managed installation storage and reclaimable space, then remove eligible old versions with one click. Projects, sessions, accounts, attachments and independently installed Codex are excluded.

From Agent 0.30.74, a healthy, connected and idle service automatically checks after installation, repair or upgrade. It retains the current version, a rollback version and any files still referenced by processes, containers or persisted state. Recently installed directories are deferred for one hour; subsequent checks occur daily. Uncertain evidence or an active upgrade prevents deletion. Interrupted manual cleanup is not replayed automatically: check again to see the actual result.

Space totals represent logical file sizes rather than guaranteed physical disk savings. Offline hosts are processed after reconnecting, and older agents must be updated first.
