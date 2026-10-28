import { Languages, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { localeOptions, setLocale, useLocale, type Locale } from "../i18n";
import { languageLoadError } from "../i18n/locales";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const language = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function choose(value: Locale) {
    setBusy(true); setFailed(false);
    try { await setLocale(value); } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <span className="language-control"><label className="language-switcher">{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Languages size={15} aria-hidden="true" />}<select aria-label="Language / 语言" aria-busy={busy} disabled={busy} value={language} onChange={event => void choose(event.target.value as Locale)}>{localeOptions.map(option => <option key={option.value} value={option.value} lang={option.value}>{compact ? option.compact : option.name}</option>)}</select></label>{failed && <span className="language-control__error" role="alert">{languageLoadError[language]}</span>}</span>;
}
