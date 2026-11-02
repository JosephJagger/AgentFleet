import { useEffect, useState } from "react";
import { t } from "../i18n";
import { newBuildAvailable } from "../lib/app-update";
import "./update-prompt.css";

const CHECK_INTERVAL_MS = 10 * 60_000;

/** Offers a refresh; never reloads on its own, so drafts, calls and streams are not interrupted. */
export function UpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (available) return;
    let active = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void newBuildAvailable().then(found => { if (active && found) setAvailable(true); });
    };
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [available]);
  if (!available || dismissed) return null;
  return <div className="update-prompt" role="status">
    <span>{t("有新版本可用，刷新后生效")}</span>
    <button type="button" className="button" onClick={() => window.location.reload()}>{t("立即刷新")}</button>
    <button type="button" className="button" onClick={() => setDismissed(true)}>{t("稍后")}</button>
  </div>;
}
