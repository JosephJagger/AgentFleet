import { CheckCircle2, KeyRound, LoaderCircle, Pencil, PlugZap, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { displayName } from "../lib/display-name";
import { t, systemText } from "../i18n";
import type { Machine, SshAccount, SshAccountInput, SshTestResult } from "../lib/types";

export const isLinuxMachine = (machine: Machine) => /^(linux|ubuntu)\b/i.test(machine.os);
type Reachable = Awaited<ReturnType<typeof api.sshReachable>>["accounts"];
const blank = (machineId: string): SshAccountInput => ({ machineId, name: "", algorithm: "ed25519", username: "", address: "", port: 22, privateKey: "", publicKey: "", passphrase: "", description: "", enabled: true, sources: [] });

function Check({ value, yes, no, unknown }: { value: boolean | null | undefined; yes: string; no: string; unknown: string }) {
  return <span className={`ssh-check ssh-check--${value === true ? "ok" : value === false ? "bad" : "unknown"}`}>{value === true ? <CheckCircle2 size={14} aria-hidden="true" /> : value === false ? <XCircle size={14} aria-hidden="true" /> : null}{value === true ? yes : value === false ? no : unknown}</span>;
}

/** Registers this host's existing SSH accounts so agents on the workspace's other Linux hosts can reach it. */
export function HostSshAccess({ machine, machines, canManage }: { machine: Machine; machines: Machine[]; canManage: boolean }) {
  const [accounts, setAccounts] = useState<SshAccount[]>([]);
  const [reachable, setReachable] = useState<Reachable>([]);
  const [draft, setDraft] = useState<SshAccountInput>();
  const [editing, setEditing] = useState<SshAccount>();
  const [tests, setTests] = useState<Record<string, SshTestResult[]>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const linux = isLinuxMachine(machine);
  const sources = machines.filter(item => item.id !== machine.id && isLinuxMachine(item));
  const nameOf = (id: string) => displayName(machines.find(item => item.id === id)?.name ?? id);
  useEffect(() => {
    if (!linux) return;
    const controller = new AbortController();
    void Promise.all([api.sshAccounts(machine.id, controller.signal), api.sshReachable(machine.id, controller.signal)])
      .then(([own, other]) => { setAccounts(own.accounts); setReachable(other.accounts); setError(""); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [machine.id, linux, reload]);

  async function act(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await operation(); setReload(n => n + 1); } catch (reason) { setError((reason as Error).message); } finally { setBusy(""); }
  }
  const edit = (account?: SshAccount) => {
    setEditing(account);
    setDraft(account ? { name: account.name, algorithm: account.algorithm, username: account.username, address: account.address, port: account.port, privateKey: "", publicKey: account.publicKey, passphrase: "", description: account.description, enabled: account.enabled, sources: account.sources } : blank(machine.id));
  };
  const update = (patch: Partial<SshAccountInput>) => setDraft(current => current && { ...current, ...patch });

  if (!linux) return <section className="settings-block host-ssh"><h2>{t("SSH 互通")}</h2><p role="status">{t("SSH 互通暂仅支持 Linux 主机")}</p></section>;
  return <section className="settings-block host-ssh">
    <div className="host-ssh__heading"><div><h2>{t("SSH 互通")}</h2><p>{t("登记本主机已有的 SSH 账号与密钥。保存后，同账号下其他 Linux 主机上的 Agent 可通过 ssh af-名称 直接操作本主机。")}</p></div>
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
        <label>{t("名称")} *<input required value={draft.name} maxLength={40} placeholder="qianyi" onChange={e => update({ name: e.target.value })} /><small>{t("Agent 使用的别名为 af-{0}", draft.name.toLowerCase() || "…")}</small></label>
        <label>{t("用户名")} *<input required value={draft.username} maxLength={32} placeholder="root" autoComplete="off" onChange={e => update({ username: e.target.value })} /></label>
        <label>{t("加密方式")} *<select value={draft.algorithm} onChange={e => update({ algorithm: e.target.value as SshAccountInput["algorithm"] })}><option value="ed25519">ED25519</option><option value="rsa">RSA</option><option value="ecdsa">ECDSA</option></select></label>
        <label>{t("密码")}<input type="password" value={draft.passphrase ?? ""} autoComplete="new-password" placeholder={editing?.hasPassphrase ? t("已保存，留空则不修改") : t("私钥口令，没有则留空")} onChange={e => update({ passphrase: e.target.value })} /></label>
        <label>{t("私钥")} *<textarea rows={5} spellCheck={false} required={!editing} value={draft.privateKey ?? ""} placeholder={editing ? t("已保存，留空则不修改") : "-----BEGIN OPENSSH PRIVATE KEY-----"} onChange={e => update({ privateKey: e.target.value })} /></label>
        <label>{t("公钥")} *<textarea rows={5} spellCheck={false} value={draft.publicKey ?? ""} placeholder={t("ssh-ed25519 AAAA…；OpenSSH 私钥可留空自动提取")} onChange={e => update({ publicKey: e.target.value })} /></label>
        <label>{t("地址")}<input value={draft.address} placeholder={editing?.effectiveAddress ? t("自动：{0}", editing.effectiveAddress) : t("留空则使用主机上报的地址")} onChange={e => update({ address: e.target.value })} /></label>
        <label>{t("端口")}<input type="number" min={1} max={65535} value={draft.port} onChange={e => update({ port: Number(e.target.value) })} /></label>
      </div>
      <label>{t("描述")}<input value={draft.description} maxLength={500} placeholder={t("告诉 Agent 这台主机的用途，例如：生产数据库，只读排查")} onChange={e => update({ description: e.target.value })} /></label>
      {sources.length > 0 && <fieldset className="host-ssh__sources"><legend>{t("可访问本主机的主机（都不选表示全部 Linux 主机）")}</legend>
        {sources.map(source => <label className="checkbox-row" key={source.id}><input type="checkbox" checked={draft.sources.includes(source.id)} onChange={e => update({ sources: e.target.checked ? [...draft.sources, source.id] : draft.sources.filter(id => id !== source.id) })} /><span>{displayName(source.name)}</span></label>)}
      </fieldset>}
      <label className="checkbox-row"><input type="checkbox" checked={draft.enabled} onChange={e => update({ enabled: e.target.checked })} /><span>{t("启用")}</span></label>
      {editing?.hasPassphrase && <label className="checkbox-row"><input type="checkbox" checked={draft.clearPassphrase === true} onChange={e => update({ clearPassphrase: e.target.checked })} /><span>{t("清除已保存的口令")}</span></label>}
      <p className="host-help">{t("私钥加密保存在面板，不会回显；它会下发到可访问本主机的 Linux 主机，仅当前系统用户可读。建议使用专用的非 root 账号。")}</p>
      <div className="host-ssh__actions"><button type="submit" className="button button--primary" disabled={busy === "save"}>{busy === "save" && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{t("保存")}</button><button type="button" className="button button--quiet" onClick={() => { setDraft(undefined); setEditing(undefined); }}>{t("取消")}</button></div>
    </form>}

    {error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
    {!accounts.length && !draft && <p className="host-help">{t("尚未登记 SSH 账号。")}</p>}
    <ul className="host-ssh__list">{accounts.map(account => <li key={account.id} className="host-ssh__item">
      <div className="host-ssh__summary"><strong><code>ssh {account.alias}</code>{!account.enabled && <span className="ssh-check ssh-check--unknown">{t("已停用")}</span>}</strong>
        <span>{account.username}@{account.effectiveAddress || t("地址未知")}:{account.port} · {account.algorithm.toUpperCase()} · <code>{account.fingerprint}</code></span>
        {account.description && <span>{account.description}</span>}
        <span>{account.sources.length ? t("可访问：{0}", account.sources.map(nameOf).join("、")) : t("可访问：全部 Linux 主机")}</span></div>
      <div className="host-ssh__checks">
        <Check value={account.verification.userExists} yes={t("账号存在")} no={t("账号不存在")} unknown={t("账号未校验")} />
        <Check value={account.verification.authorized} yes={t("公钥已授权")} no={t("公钥不在 authorized_keys")} unknown={t("授权未校验")} />
        <Check value={account.hostKeyFingerprints.length ? true : null} yes={t("主机指纹已固定")} no="" unknown={t("指纹未固定，首次连接时信任")} />
        {account.delivered.map(item => <Check key={item.machineId} value={item.ok} yes={t("已下发到 {0}", nameOf(item.machineId))} no={t("{0} 下发失败：{1}", nameOf(item.machineId), item.error ?? "")} unknown="" />)}
      </div>
      {account.verification.error && <p className="catalog-error">{systemText(account.verification.error)}</p>}
      {tests[account.id] && <ul className="host-ssh__tests">{tests[account.id]!.length ? tests[account.id]!.map(result => <li key={result.machineId}><Check value={result.ok} yes={t("{0} → 连接成功（{1} ms）", displayName(result.machineName), String(result.durationMs ?? 0))} no={t("{0} → {1}", displayName(result.machineName), result.error ?? t("连接失败"))} unknown="" /></li>) : <li>{t("没有可用于测试的在线 Linux 主机")}</li>}</ul>}
      <div className="host-ssh__actions">
        <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void act(`test:${account.id}`, async () => { const { results } = await api.testSshAccount(account.id); setTests(current => ({ ...current, [account.id]: results })); })}>{busy === `test:${account.id}` ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}{t("测试连接")}</button>
        <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void act(`verify:${account.id}`, () => api.verifySshAccount(account.id))}>{busy === `verify:${account.id}` ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{t("重新校验并下发")}</button>
        {canManage && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => edit(account)}><Pencil size={15} aria-hidden="true" />{t("编辑")}</button>}
        {canManage && <button type="button" className="button button--danger-quiet" disabled={Boolean(busy)} onClick={() => { if (window.confirm(t("删除后，其他主机将无法再通过 {0} 访问本主机。确定删除？", account.alias))) void act(`delete:${account.id}`, () => api.deleteSshAccount(account.id)); }}><Trash2 size={15} aria-hidden="true" />{t("删除")}</button>}
      </div>
    </li>)}</ul>

    <h3>{t("本主机可访问的其他主机")}</h3>
    {reachable.length ? <ul className="host-ssh__reachable">{reachable.map(account => <li key={account.id}><code>ssh {account.alias}</code> → {displayName(account.targetName)}（{account.username}@{account.hostname}:{account.port}）{account.description && ` · ${account.description}`}</li>)}</ul>
      : <p className="host-help">{t("暂无。其他 Linux 主机登记 SSH 账号后，会自动出现在这里，并告知本主机上的 Agent。")}</p>}
  </section>;
}
