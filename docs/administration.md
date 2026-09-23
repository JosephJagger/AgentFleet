# Platform administration

The **Admin** tab is available only to the account configured by `ADMIN_EMAIL`. This is a platform role, distinct from ownership of a personal workspace. Email verification proves identity; registration never grants platform administration.

- Admin: user search (10 per page), disable/enable accounts, sign out all browsers, managed Codex validation/promotion/rollback and system build information.
- Settings: personal appearance, writing assistance, browser sessions and project history retention.
- Hosts: each user's own host connections, defaults, permissions, maintenance and attachments.

Admin API requests require server-side administrator authorization. Mutations also require a valid session, allowed Origin and CSRF token. Hiding the tab is not the security boundary. Public release targets and installer artifacts remain readable so agents can update without browser credentials; they contain no account credentials.

Disabling an account blocks new sign-ins, revokes existing browser sessions, closes their live connections, and releases browser control leases/cancels unfinished enrollment transactions through the normal logout cleanup. It retains host/project/session data and does not kill or replay native tasks already running. Enabling the account does not restore revoked sessions. The configured administrator cannot be disabled through this page. Account actions are audited.

Administration exposes account metadata and host counts, not other users' conversation contents, files, credentials or API keys. Existing workspace-scoped APIs remain workspace-scoped even for the platform administrator. Deployments should configure `ADMIN_EMAIL` to an address they control; there is no first-user-wins rule or browser-side role promotion. Mail/service credentials remain deployment configuration, not editable or readable in the panel.

## 中文

“管理”页仅对部署配置 `ADMIN_EMAIL` 指定的账号开放，普通注册用户不会获得平台管理员权限。用户管理支持按邮箱搜索、每页 10 人、禁用/恢复及退出全部浏览器；全站 Codex 升级、回退和系统版本也集中在这里。

普通用户仍能管理自己工作区的主机、项目、会话、附件和个人设置。管理员同样不能通过这些接口跨工作区读取其他人的会话正文和凭据。

禁用会阻止登录、撤销已有浏览器登录并断开实时连接；保留数据，不中断或重发已执行的原生任务。恢复后需重新登录。管理接口由后端校验权限，写操作同时校验 Origin 与 CSRF，所有账号管理操作记录审计。管理员本人受保护，邮件密钥等仅保留在部署配置中。
