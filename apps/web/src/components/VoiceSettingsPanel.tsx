import { useEffect, useState } from "react";
import { api, type VoicePreferences } from "../lib/api";
import { t, systemText } from "../i18n";

export function VoiceSettingsPanel() {
  const [data, setData] = useState<VoicePreferences>();
  const [voice, setVoice] = useState("sol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError(""); setSaved(false);
    void Promise.resolve().then(() => api.voicePreferences(controller.signal)).then(next => {
      if (!controller.signal.aborted) { setData(next); setVoice(next.voice); }
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [reload]);
  async function save() {
    if (!data || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { const next = await api.saveVoicePreferences({ voice, revision: data.revision }); setData(next); setVoice(next.voice); setSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="codex-settings-panel session-config-section" aria-label={t("语音音色")}>
    <h3>{t("语音音色")}</h3>
    <p>{t("会话语音与面板总控统一使用此音色。保存后从下一次通话生效，当前通话不变。")}</p>
    {data ? <label>{t("音色")}<select value={voice} disabled={busy} onChange={e => { setVoice(e.target.value); setSaved(false); }}>
      {data.voices.map(name => <option key={name} value={name}>{name.charAt(0).toUpperCase() + name.slice(1)}{name === "sol" ? ` · ${t("默认")}` : ""}</option>)}
    </select></label> : !error && <p>{t("读取中")}</p>}
    <p className="subtle">{t("音色选项来自托管 Codex 原生接口；切换音色需要连接服务 0.30.73 或更新版本。")}</p>
    <div className="codex-settings-save"><button type="button" className="button button--primary" disabled={!data || busy || voice === data.voice} onClick={() => void save()}>{t("保存音色")}</button><button type="button" className="button button--quiet" disabled={busy} onClick={() => setReload(n => n + 1)}>{t("重新读取配置")}</button></div>
    {error && <p role="alert">{systemText(error)}</p>}
    {saved && <p role="status">{t("音色已保存，下次通话生效。")}</p>}
  </section>;
}
