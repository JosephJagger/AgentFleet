import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Users } from "lucide-react";
import { api, type AdminUser } from "../lib/api";
import { t, locale, systemText } from "../i18n";
import { RuntimeReleasePanel } from "./RuntimeReleasePanel";
import { SettingsPagination } from "./SettingsPagination";

type Action = "disable" | "enable" | "revoke-sessions";
const date = (value: string | null) => value ? new Date(value).toLocaleString(locale()) : t("未记录");

export function AdminView() {
  const [section, setSection] = useState<"users" | "runtime" | "system">("users");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.adminUsers>>>();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ user: AdminUser; action: Action }>();
  const [busy, setBusy] = useState(false);
  const [release, setRelease] = useState<Awaited<ReturnType<typeof api.release>>>();
  const [system, setSystem] = useState<Awaited<ReturnType<typeof api.adminSystem>>>();
  const [systemError, setSystemError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([api.release(), api.adminSystem()]).then(([version, config]) => {
      if (active) { setRelease(version); setSystem(config); setSystemError(""); }
    }).catch(reason => { if (active) setSystemError(systemText(reason instanceof Error ? reason.message : t("操作未完成"))); });
    return () => { active = false; };
  }, [reload, section]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setData(undefined); setPending(undefined);
    void api.adminUsers(page, query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(systemText(reason instanceof Error ? reason.message : t("操作未完成"))); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, query, reload]);
  async function change() {
    if (!pending || busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.adminUserAction(pending.user.id, pending.action); setPending(undefined); setNotice(t("用户状态已更新")); setReload(value => value + 1); }
    catch (reason) { setError(systemText(reason instanceof Error ? reason.message : t("操作未完成"))); }
    finally { setBusy(false); }
  }
  return <section className="wide-view admin-view">
    <div className="wide-view__heading"><div><h1>{t("管理")}</h1><p>{t("仅平台管理员可访问。管理用户及全站运行策略。")}</p></div><ShieldCheck size={30} /></div>
    <nav className="admin-sections" aria-label={t("管理分类")}>{([['users', t("用户管理")], ['runtime', t("托管升级")], ['system', t("系统信息")]] as const).map(([value, title]) => <button key={value} className={`button ${section === value ? "button--primary" : "button--quiet"}`} aria-current={section === value ? "page" : undefined} onClick={() => setSection(value)}>{title}</button>)}</nav>
    {section === "users" && <section className="settings-block admin-users"><h2><Users size={20} />{t("用户管理")}</h2>
      <p className="subtle">{t("仅展示账号状态与主机数量，不提供其他用户的会话正文或登录凭据。")}</p>
      <form className="admin-search" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); setReload(value => value + 1); }}>
        <input aria-label={t("搜索用户邮箱")} placeholder={t("搜索用户邮箱")} maxLength={254} value={search} onChange={event => setSearch(event.target.value)} />
        <button className="button button--quiet" disabled={busy} type="submit">{t("搜索")}</button>
        <button className="button button--quiet" disabled={busy} type="button" aria-label={t("刷新用户列表")} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button>
      </form>
      {loading && <p role="status">{t("读取中")}</p>}
      {data && <><p className="subtle">{t("共 {0} 位用户", data.total)}</p><div className="admin-user-list">{data.users.map(user => <article className="admin-user" key={user.id}>
        <div className="admin-user__identity"><strong title={user.email}>{user.email}</strong><span>{user.platformAdmin ? t("平台管理员") : t("普通用户")} · {user.disabled ? t("已禁用") : t("正常")}</span><small>{t("主机数量：{0}", user.machineCount)}</small><small>{t("最近登录：{0}", date(user.lastLoginAt))}</small><small>{t("注册时间：{0}", date(user.createdAt))}</small></div>
        {!user.platformAdmin && <div className="admin-user__actions"><button className="button button--quiet" disabled={busy} onClick={() => setPending({ user, action: user.disabled ? "enable" : "disable" })}>{user.disabled ? t("恢复账号") : t("禁用账号")}</button><button className="button button--quiet" disabled={busy || user.disabled} onClick={() => setPending({ user, action: "revoke-sessions" })}>{t("退出全部浏览器")}</button></div>}
      </article>)}</div>{data.users.length === 0 && <p>{t("没有匹配的用户")}</p>}<SettingsPagination page={data.page - 1} pages={data.pages} onChange={value => setPage(value + 1)} label={t("用户分页")} /></>}
      {pending && <div className="runtime-release-confirm" role="group" aria-label={t("确认账号操作")}><strong>{pending.user.email}</strong><p>{pending.action === "disable" ? t("禁用后将退出全部浏览器，并阻止该账号登录。保留主机、项目和会话，不中断已在执行的任务。") : pending.action === "enable" ? t("恢复后，该用户可重新登录；此前退出的浏览器不会自动恢复。") : t("该用户的全部浏览器将退出登录，需要重新验证身份。")}</p><button className="button button--danger" disabled={busy} onClick={() => void change()}>{busy ? t("正在处理…") : t("确认")}</button><button className="button button--quiet" disabled={busy} onClick={() => setPending(undefined)}>{t("取消")}</button></div>}
      {error && <p className="catalog-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section>}
    {section === "runtime" && <RuntimeReleasePanel />}
    {section === "system" && <section className="settings-block"><h2>{t("系统信息")}</h2>{systemError && <p role="alert" className="catalog-error">{systemError}</p>}
      {release && <dl className="host-release-facts"><div><dt>{t("当前面板构建")}</dt><dd><code>{release.build}</code></dd></div><div><dt>{t("已发布连接服务")}</dt><dd>{release.agentVersion}</dd></div><div><dt>{t("数据库版本")}</dt><dd>{release.schema}</dd></div></dl>}
      {release?.manifestStatus && release.manifestStatus !== "ready" && <p className="catalog-error">{t("安装文件暂不可用，添加或更新主机可能失败。")}</p>}
      {system && <p>{t("登录方式")}：{system.authMode === "email" ? t("邮箱验证码") : t("管理员预置账号")}</p>}
      <p className="subtle">{t("管理员身份由部署配置指定；邮件密钥和服务凭据不在网页中展示。")}</p>
    </section>}
  </section>;
}
