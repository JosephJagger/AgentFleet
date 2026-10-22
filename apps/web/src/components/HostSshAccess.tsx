import { CheckCircle2, KeyRound, LoaderCircle, Pencil, PlugZap, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { displayName } from "../lib/display-name";
import { t, systemText } from "../i18n";
import type { Machine, SshAccount, SshAccountInput, SshAddressKind, SshLinkMatrix, SshTestResult } from "../lib/types";
import { HostLinkMatrix } from "./HostLinkMatrix";

export const isSshMachine = (machine: Machine) => /^(linux|ubuntu|darwin|macos)\b/i.test(machine.os);
const isMac = (machine: Machine) => /^(darwin|macos)\b/i.test(machine.os);
const KIND_LABELS: Record<SshAddressKind, string> = { lan: "局域网", public: "公网", overlay: "虚拟网络" };
type Reachable = Awaited<ReturnType<typeof api.sshReachable>>["accounts"];
const blank = (machineId: string): SshAccountInput => ({ machineId, username: "", address: "", port: 22, privateKey: "", passphrase: "", description: "", enabled: true, sources: [], route: "direct" });

function Check({ value, yes, no, unknown }: { value: boolean | null | undefined; yes: string; no: string; unknown: string }) {
  return <span className={`ssh-check ssh-check--${value === true ? "ok" : value === false ? "bad" : "unknown"}`}>{value === true ? <CheckCircle2 size={14} aria-hidden="true" /> : value === false ? <XCircle size={14} aria-hidden="true" /> : null}{value === true ? yes : value === false ? no : unknown}</span>;
}

/** Registers this host's existing SSH accounts so agents on the workspace's other Linux and macOS hosts can reach it, and shows how each host reaches each other. */
export function HostSshAccess({ machine, machines, canManage }: { machine: Machine; machines: Machine[]; canManage: boolean }) {
  const [accounts, setAccounts] = useState<SshAccount[]>([]);
  const [reachable, setReachable] = useState<Reachable>([]);
  const [draft, setDraft] = useState<SshAccountInput>();
  const [editing, setEditing] = useState<SshAccount>();
  const [tests, setTests] = useState<Record<string, SshTestResult[]>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [links, setLinks] = useState<SshLinkMatrix>();
  const supported = isSshMachine(machine);
  const sources = machines.filter(item => item.id !== machine.id && isSshMachine(item));
  const nameOf = (id: string) => displayName(machines.find(item => item.id === id)?.name ?? id);
  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    // The matrix is an overview; failing to load it must not hide the accounts themselves.
    const loadLinks = async () => { try { return await api.sshLinks(controller.signal); } catch { return undefined; } };
    void Promise.all([api.sshAccounts(machine.id, controller.signal), api.sshReachable(machine.id, controller.signal), loadLinks()])
      .then(([own, other, matrix]) => { setAccounts(own.accounts); setReachable(other.accounts); setLinks(matrix); setError(""); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [machine.id, supported, reload]);

  async function act(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await operation(); setReload(n => n + 1); } catch (reason) { setError((reason as Error).message); } finally { setBusy(""); }
  }
  const edit = (account?: SshAccount) => {
    setEditing(account);
    setDraft(account ? { username: account.username, address: account.address, port: account.port, privateKey: "", passphrase: "", description: account.description, enabled: account.enabled, sources: account.sources,
      route: account.route === "proxyjump" ? "proxyjump" : "direct", ...(account.proxyJumpMachineId ? { proxyJumpMachineId: account.proxyJumpMachineId } : {}) } : blank(machine.id));
  };
  const update = (patch: Partial<SshAccountInput>) => setDraft(current => current && { ...current, ...patch });
  // A jump host must already have a direct account of its own, so only such hosts are offered.
  const jumpHosts = [...new Set((links?.links ?? []).filter(link => link.route === "direct" && link.enabled && link.targetMachineId !== machine.id).map(link => link.targetMachineId))];
  const candidates = editing?.verification.addresses ?? [];
  const testAll = () => act("test-all", async () => { for (const link of links?.links ?? []) await api.testSshAccount(link.accountId); });

  if (!supported) return <section className="settings-block host-ssh"><h2>{t("主机互通")}</h2><p role="status">{t("主机互通仅支持 Linux 和 macOS 主机")}</p></section>;
  return <section className="settings-block host-ssh">
    <div className="host-ssh__heading"><div><h2>{t("主机互通")}</h2><p>{t("填写 SSH 用户名和私钥，其他已授权的 Linux 或 macOS 主机即可连接本主机。公钥和密钥类型自动识别。")}</p></div>
      {canManage && !draft && <button type="button" className="button button--primary" onClick={() => edit()}><KeyRound size={16} aria-hidden="true" />{t("添加 SSH 账号")}</button>}</div>
    {!canManage && <p className="host-help">{t("仅平台管理员可以添加或修改 SSH 账号。")}</p>}

    {draft && <form className="stack-form host-ssh__form" onSubmit={event => {
      event.preventDefault();
      void act("save", async () => {
        const input = { ...draft, ...(draft.privateKey ? {} : { privateKey: undefined }), ...(draft.passphrase ? {} : { passphrase: undefined }) };
        await api.saveSshAccount(input, editing?.id); setDraft(undefined); setEditing(undefined);
      });
    }}>
      <div className="host-ssh__grid">
        <label>{t("用户名")} *<input required value={draft.username} maxLength={32} placeholder="root" autoComplete="off" onChange={e => update({ username: e.target.value })} /></label>
        <label>{t("地址")}<input value={draft.address} placeholder={editing?.effectiveAddress ? t("自动：{0}", editing.effectiveAddress) : t("留空则使用主机上报的地址")} onChange={e => update({ address: e.target.value })} /></label>
        <label>{t("端口")}<input type="number" min={1} max={65535} value={draft.port} onChange={e => update({ port: Number(e.target.value) })} /></label>
        <label className="host-ssh__key">{t("私钥")} *<textarea rows={5} spellCheck={false} required={!editing} value={draft.privateKey ?? ""} placeholder={editing ? t("已保存，留空则不修改") : "-----BEGIN OPENSSH PRIVATE KEY-----"} onChange={e => update({ privateKey: e.target.value })} /></label>
      </div>
      <div className="host-ssh__grid host-ssh__grid--route">
        <label>{t("连接方式")}<select value={draft.route ?? "direct"} onChange={e => update({ route: e.target.value === "proxyjump" ? "proxyjump" : "direct" })}>
          <option value="direct">{t("直连")}</option>
          <option value="proxyjump" disabled={!jumpHosts.length}>{t("经跳板机")}</option></select></label>
        {draft.route === "proxyjump" && <label>{t("跳板机")} *<select required value={draft.proxyJumpMachineId ?? ""} onChange={e => update({ proxyJumpMachineId: e.target.value })}>
          <option value="">{t("请选择")}</option>{jumpHosts.map(id => <option key={id} value={id}>{nameOf(id)}</option>)}</select></label>}
        {candidates.length > 0 && <label>{t("候选地址")}<select value="" onChange={e => { if (e.target.value) update({ address: e.target.value }); }}>
          <option value="">{t("选择后填入地址…")}</option>{candidates.map(address => { const kind = editing?.verification.addressKinds?.[address]; return <option key={address} value={address}>{kind ? `${address} · ${t(KIND_LABELS[kind])}` : address}</option>; })}</select></label>}
      </div>
      <p className="host-help">{!jumpHosts.length ? t("经跳板机需要先为另一台主机登记一个直连的 SSH 账号。") : t("主机不在同一网络时，可填写虚拟网络（如 Tailscale、WireGuard）的地址，或选择经跳板机连接。")}</p>
      <p className="host-help">{editing ? t("连接命令：{0}", `ssh ${editing.alias}`) : t("连接别名自动使用 af-主机名，重名时添加序号；保存后显示连接命令。")}</p>
      <details open={editing?.hasPassphrase || undefined}>
        <summary>{t("更多选项（私钥口令、描述）")}</summary>
        <label>{t("私钥口令")}<input type="password" value={draft.passphrase ?? ""} autoComplete="new-password" placeholder={editing?.hasPassphrase ? t("已保存，留空则不修改") : t("私钥已加密时填写，不是 SSH 登录密码")} onChange={e => update({ passphrase: e.target.value })} /></label>
        {editing?.hasPassphrase && <label className="checkbox-row"><input type="checkbox" checked={draft.clearPassphrase === true} onChange={e => update({ clearPassphrase: e.target.checked })} /><span>{t("清除已保存的口令")}</span></label>}
        <label>{t("描述")}<input value={draft.description} maxLength={500} placeholder={t("告诉 Agent 这台主机的用途，例如：生产数据库，只读排查")} onChange={e => update({ description: e.target.value })} /></label>
      </details>
      {sources.length > 0 && <fieldset className="host-ssh__sources"><legend>{t("可访问本主机的主机（都不选表示全部主机）")}</legend>
        {sources.map(source => <label className="checkbox-row" key={source.id}><input type="checkbox" checked={draft.sources.includes(source.id)} onChange={e => update({ sources: e.target.checked ? [...draft.sources, source.id] : draft.sources.filter(id => id !== source.id) })} /><span>{displayName(source.name)}</span></label>)}
      </fieldset>}
      <label className="checkbox-row"><input type="checkbox" checked={draft.enabled} onChange={e => update({ enabled: e.target.checked })} /><span>{t("启用")}</span></label>
      <p className="host-help">{t("私钥加密保存在面板，不会回显；它会下发到可访问本主机的 Linux 或 macOS 主机，仅当前系统用户可读。建议使用专用的非 root 账号。")}</p>
      <div className="host-ssh__actions"><button type="submit" className="button button--primary" disabled={busy === "save"}>{busy === "save" && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{t("保存")}</button><button type="button" className="button button--quiet" onClick={() => { setDraft(undefined); setEditing(undefined); }}>{t("取消")}</button></div>
    </form>}

    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    {!accounts.length && !draft && <p className="host-help">{t("尚未登记 SSH 账号。")}</p>}
    <ul className="host-ssh__list">{accounts.map(account => <li key={account.id} className="host-ssh__item">
      <div className="host-ssh__summary"><strong><code>ssh {account.alias}</code>{!account.enabled && <span className="ssh-check ssh-check--unknown">{t("已停用")}</span>}</strong>
        <span>{account.username}@{account.effectiveAddress || t("地址未知")}:{account.port} · {account.algorithm.toUpperCase()} · <code>{account.fingerprint}</code></span>
        {account.description && <span>{account.description}</span>}
        <span>{account.sources.length ? t("可访问：{0}", account.sources.map(nameOf).join("、")) : t("可访问：全部主机")}</span>
        {account.route === "proxyjump" && account.proxyJumpMachineId && <span>{t("经 {0} 跳转", nameOf(account.proxyJumpMachineId))}</span>}</div>
      <div className="host-ssh__checks">
        <Check value={account.verification.userExists} yes={t("账号存在")} no={t("账号不存在")} unknown={t("账号未校验")} />
        <Check value={account.verification.authorized} yes={t("公钥已授权")} no={t("公钥不在 authorized_keys")} unknown={t("授权未校验")} />
        {account.verification.listening !== undefined && account.verification.listening !== null && <Check value={account.verification.listening} yes={t("sshd 正在监听")} no={isMac(machine) ? t("sshd 未监听：请在 系统设置 → 通用 → 共享 中打开远程登录") : t("sshd 未监听")} unknown="" />}
        <Check value={account.hostKeyFingerprints.length ? true : null} yes={t("主机指纹已固定")} no="" unknown={t("指纹未固定，首次连接时信任")} />
        {account.delivered.map(item => <Check key={item.machineId} value={item.ok} yes={t("已下发到 {0}", nameOf(item.machineId))} no={t("{0} 下发失败：{1}", nameOf(item.machineId), item.error ?? "")} unknown="" />)}
      </div>
      {account.verification.error && <p className="catalog-error">{systemText(account.verification.error)}</p>}
      {tests[account.id] && <ul className="host-ssh__tests">{tests[account.id]!.length ? tests[account.id]!.map(result => <li key={result.machineId}><Check value={result.ok} yes={result.path === "proxyjump" ? t("{0} → 经跳板机连接成功（{1} ms）", displayName(result.machineName), String(result.durationMs ?? 0)) : t("{0} → 连接成功（{1} ms）", displayName(result.machineName), String(result.durationMs ?? 0))} no={t("{0} → {1}", displayName(result.machineName), result.error ?? t("连接失败"))} unknown="" /></li>) : <li>{t("没有可用于测试的在线主机")}</li>}</ul>}
      <div className="host-ssh__actions">
        {canManage && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void act(`test:${account.id}`, async () => { const { results } = await api.testSshAccount(account.id); setTests(current => ({ ...current, [account.id]: results })); })}>{busy === `test:${account.id}` ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}{t("测试连接")}</button>}
        {canManage && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void act(`verify:${account.id}`, () => api.verifySshAccount(account.id))}>{busy === `verify:${account.id}` ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{t("重新校验并下发")}</button>}
        {canManage && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => edit(account)}><Pencil size={15} aria-hidden="true" />{t("编辑")}</button>}
        {canManage && <button type="button" className="button button--danger-quiet" disabled={Boolean(busy)} onClick={() => { if (window.confirm(t("删除后，其他主机将无法再通过 {0} 访问本主机。确定删除？", account.alias))) void act(`delete:${account.id}`, () => api.deleteSshAccount(account.id)); }}><Trash2 size={15} aria-hidden="true" />{t("删除")}</button>}
      </div>
    </li>)}</ul>

    {links && <HostLinkMatrix matrix={links} canManage={canManage} busy={busy === "test-all"} onTestAll={() => void testAll()} />}

    <h3>{t("本主机可访问的其他主机")}</h3>
    {reachable.length ? <ul className="host-ssh__reachable">{reachable.map(account => <li key={account.id}><code>ssh {account.alias}</code> → {displayName(account.targetName)}（{account.username}@{account.hostname}:{account.port}）{account.description && ` · ${account.description}`}</li>)}</ul>
      : <p className="host-help">{t("暂无。其他 Linux 或 macOS 主机登记 SSH 账号后，会自动出现在这里，并告知本主机上的 Agent。")}</p>}
  </section>;
}
