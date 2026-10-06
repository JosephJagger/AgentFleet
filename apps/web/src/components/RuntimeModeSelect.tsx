import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t, systemText } from "../i18n";
import type { RuntimeSummary } from "./CodexSettingsPanel";

/** Saves only the mode, preserving independently inherited model/effort fields. */
export function RuntimeModeSelect({ sessionId, summary, running, onSaved }: { sessionId: string; summary?: RuntimeSummary; running: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => { ++generation.current; setBusy(false); setError(""); return () => { ++generation.current; }; }, [sessionId]);
  const current = summary?.sessionId === sessionId ? summary : undefined;
  const mode = current?.mode ?? current?.settings?.mode ?? "default";
  const source = ({ workspace: "统一默认", machine: "主机默认", project: "项目默认", session: "会话覆盖" } as Record<string, string>)[current?.modeSource ?? "workspace"] ?? "统一默认";
  async function save(value: string) {
    const gen = generation.current; setBusy(true); setError("");
    try {
      const prefs = await api.codexPreferences(sessionId);
      if (generation.current !== gen) return;
      const pref = prefs.preferences.session;
      const overrides = { ...(pref.overrides ?? pref.settings ?? {}) };
      if (value === "inherit") delete overrides.mode;
      else overrides.mode = value as "default" | "plan";
      await api.saveRuntimePreferences("session", sessionId, { scope: "session", overrides, revision: pref.revision });
      if (generation.current === gen) onSaved();
    } catch (err) { if (generation.current === gen) setError((err as Error).message); }
    finally { if (generation.current === gen) setBusy(false); }
  }
  return <div className="runtime-mode-select">
    <label><span>{t(running ? "下一轮模式" : "发送模式")}</span><select aria-label={t("切换协作模式")} disabled={busy || !current?.loaded} value={mode} onChange={event => void save(event.target.value)}>
      <option value="default">{t("普通执行")}</option><option value="plan">{t("规划模式")}</option><option value="inherit">{t("恢复继承模式")}</option>
    </select></label><small>{t(source)} · {t("用于后续发送")}</small>
    {error && <span role="alert">{systemText(error)}</span>}
  </div>;
}
