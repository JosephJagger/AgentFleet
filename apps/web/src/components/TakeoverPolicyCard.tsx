import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";

const presets = [3, 7, 14, 21, 28, 30];
export function TakeoverPolicyCard() {
  const [saved, setSaved] = useState<{ idleDays: number; revision: number }>();
  const [days, setDays] = useState("");
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setNotice("");
    void api.takeoverPolicy(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSaved(value); setDays(String(value.idleDays)); setCustom(!presets.includes(value.idleDays));
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("读取设置失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const valid = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 30;
  async function save() {
    if (!saved || !valid || busy || loading || Number(days) === saved.idleDays) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.saveTakeoverPolicy({ idleDays: Number(days), revision: saved.revision });
      setSaved(value); setNotice(t("已保存，下次闲置检查时按新设置执行。"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("保存失败，请重试")); }
    finally { setBusy(false); }
  }
  return <section className="settings-block takeover-policy-card" aria-labelledby="takeover-policy-title">
    <header><h2 id="takeover-policy-title">{t("接管管理")}</h2><span className="subtle">{t("整个工作区 · 所有主机与项目")}</span></header>
    <p className="subtle">{t("闲置到期仅取消接管、释放写入权，不删除会话或历史。与下方正文保存时长独立。")}</p>
    {loading ? <p role="status">{t("正在读取设置…")}</p> : saved && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="takeover-policy-options"><legend>{t("闲置多久后自动取消接管")}</legend>
        <div className="takeover-policy-presets" role="group" aria-label={t("闲置时长快捷选项")}>
          {presets.map(value => <button key={value} type="button" aria-pressed={!custom && Number(days) === value} className={`button ${!custom && Number(days) === value ? "button--primary" : "button--quiet"}`} onClick={() => { setDays(String(value)); setCustom(false); setNotice(""); }}>{t("{0} 天", value)}</button>)}
          <button type="button" aria-pressed={custom} className={`button ${custom ? "button--primary" : "button--quiet"}`} onClick={() => { setCustom(true); setNotice(""); }}>{t("自定义")}</button>
        </div>
        {custom && <label className="takeover-policy-custom">{t("自定义天数")}<input type="number" min={1} max={30} step={1} inputMode="numeric" value={days} onChange={event => { setDays(event.target.value); setNotice(""); }} aria-describedby="takeover-days-help"/><small id="takeover-days-help">{t("1 至 30 的整数天")}</small></label>}
      </fieldset>
      <p className="subtle">{t("从最近一次接管或 token 使用中较新的时间起算。每小时检查一次；任务、通话及待处理操作未安全结束时不会强制释放。")}</p>
      <button type="submit" className="button button--primary" disabled={busy || !valid || Number(days) === saved.idleDays}>{busy ? t("正在保存…") : t("保存接管设置")}</button>
    </form>}
    {error && <p role="alert" className="catalog-error">{systemText(error)} <button type="button" className="button button--quiet" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>{t("重新读取")}</button></p>}
    {notice && <p role="status" className="subtle">{notice}</p>}
  </section>;
}
