import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowRight, LoaderCircle } from "lucide-react";
import { locale, t } from "../i18n";
import { api } from "../lib/api";
import { ApiError, type Dashboard } from "../lib/types";

interface PendingCode { challengeId: string; email: string; expiresAt: number; resendAt: number }
const storageKey = "agentfleet.email-login";
function restore(): PendingCode | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as PendingCode | null;
    if (value && typeof value.challengeId === "string" && typeof value.email === "string"
      && Number.isFinite(value.expiresAt) && Number.isFinite(value.resendAt) && value.expiresAt > Date.now()) return value;
  } catch { /* Private browsing can disable storage. */ }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "INVALID_OR_EXPIRED_CODE") return t("验证码无效或已过期，请检查后重试。");
    if (error.code === "RATE_LIMITED") return t("尝试次数太多，请稍后再试。");
    if (error.code === "EMAIL_DELIVERY_UNAVAILABLE" || error.code === "IDENTITY_UNAVAILABLE") return t("邮件登录暂时不可用，请稍后再试。");
    if (error.code === "INVALID_INPUT") return t("请检查邮箱或验证码后再试。");
  }
  return t("暂时无法连接，请检查网络后再试。");
}

export function EmailLoginForm({ onLogin }: { onLogin: (dashboard: Dashboard) => void }) {
  const [pending, setPending] = useState<PendingCode | undefined>(restore);
  const [email, setEmail] = useState(pending?.email ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const resendSeconds = pending ? Math.max(0, Math.ceil((pending.resendAt - clock) / 1000)) : 0;
  useEffect(() => {
    try {
      if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending));
      else sessionStorage.removeItem(storageKey);
    } catch { /* The in-memory flow still works. */ }
    input.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (pending && pending.expiresAt <= clock) {
      setPending(undefined); setCode("");
      setError(t("验证码已过期，请重新获取。"));
    }
  }, [clock, pending]);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const destination = pending?.email ?? email.trim();
      const result = await api.requestLoginCode(destination, locale() === "zh-CN" ? "zh" : "en");
      const now = Date.now();
      setPending({ challengeId: result.challengeId, email: destination, expiresAt: now + result.expiresIn * 1000, resendAt: now + result.resendAfter * 1000 });
      setClock(now); setCode("");
    } catch (caught) {
      if (caught instanceof ApiError && caught.retryAfterSeconds) {
        setPending(current => current ? { ...current, resendAt: Date.now() + caught.retryAfterSeconds! * 1000 } : current);
        setClock(Date.now());
      }
      setError(describeError(caught));
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pending) { await send(); return; }
    if (inFlight.current || code.length !== 6) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await api.verifyLoginCode(pending.challengeId, code);
      try { sessionStorage.removeItem(storageKey); } catch { /* optional */ }
      onLogin(result.dashboard);
    } catch (caught) { setError(describeError(caught)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <form onSubmit={submit} aria-busy={busy}>
    {!pending ? <label>
      <span>{t("邮箱")}</span>
      <input ref={input} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email}
        onChange={event => setEmail(event.target.value)} maxLength={254} required disabled={busy} autoFocus />
    </label> : <>
      <p className="subtle" role="status">{t("验证码已发送至")} <strong>{pending.email}</strong></p>
      <label>
        <span>{t("6 位验证码")}</span>
        <input key={pending.challengeId} ref={input} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required disabled={busy} autoFocus />
      </label>
    </>}
    {error && <div className="form-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    <button className="button button--primary login-submit" disabled={busy || (Boolean(pending) && code.length !== 6)}>
      {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
      {busy ? pending ? t("正在验证") : t("正在发送验证码") : pending ? t("验证并登录") : t("发送验证码")}
    </button>
    {pending && <div className="login-code-actions">
      <button className="button" type="button" disabled={busy || resendSeconds > 0} onClick={() => void send()}>
        {t("重新发送验证码")}{resendSeconds > 0 ? ` · ${resendSeconds}s` : ""}
      </button>
      <button className="button" type="button" disabled={busy} onClick={() => { setPending(undefined); setCode(""); setError(""); }}>{t("修改邮箱")}</button>
    </div>}
  </form>;
}
