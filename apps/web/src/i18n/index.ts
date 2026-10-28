import { useSyncExternalStore } from "react";
import english from "./en.json";
import { formatCount, isLocale, resolveLocale, type CountUnit, type Locale } from "./locales";
export { localeOptions, resolveLocale, type Locale } from "./locales";

const key = "agentfleet.locale";
const listeners = new Set<() => void>();
function initialLocale(): Locale {
  try { const saved = localStorage.getItem(key); if (isLocale(saved)) return saved; } catch { /* Storage may be unavailable. */ }
  return typeof navigator !== "undefined" ? resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) : "en";
}
type Catalog = Record<string, string>;
const catalogs = new Map<Locale, Catalog>([["en", english], ["zh-CN", {}]]);
const loaders = import.meta.glob<Catalog>("./*.json", { import: "default" });
const pending = new Map<Locale, Promise<void>>();
const preferred = initialLocale();
let current: Locale = catalogs.has(preferred) ? preferred : "en";
let selection = 0;
export const locale = () => current;
function activate(value: Locale, persist: boolean) {
  current = value;
  if (persist) try { localStorage.setItem(key, value); } catch { /* The current page can still switch. */ }
  updateDocument();
  listeners.forEach(listener => listener());
}
export async function loadLocale(value: Locale): Promise<void> {
  if (catalogs.has(value)) return;
  let loading = pending.get(value);
  if (!loading) {
    const loader = loaders[`./${value}.json`];
    if (!loader) throw new Error("LOCALE_UNAVAILABLE");
    loading = loader().then(catalog => {
      catalogs.set(value, catalog);
      registerSystemMessages(catalog);
    }).finally(() => pending.delete(value));
    pending.set(value, loading);
  }
  await loading;
}
/** Load before changing the UI, so switching never flashes a fallback language. */
export function setLocale(value: Locale): Promise<void> | void {
  if (!isLocale(value)) return Promise.reject(new Error("LOCALE_UNAVAILABLE"));
  const request = ++selection;
  if (catalogs.has(value)) { if (value !== current) activate(value, true); return; }
  return loadLocale(value).then(() => { if (request === selection) activate(value, true); });
}
export function useLocale() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, locale, () => "zh-CN" as Locale);
}
function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = current;
  document.querySelector('meta[name="description"]')?.setAttribute("content", `AgentFleets — ${t("在一个工作台连接 Codex、Claude Code 与你的多台主机。")}`);
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", current === "zh-CN" ? "/manifest.webmanifest" : `/manifest.${current}.webmanifest`);
}
const messages: Record<string, string> = english;
/** Only call for application-owned text, never user content or native output. */
export function t(source: string, ...values: unknown[]): string {
  const catalog = catalogs.get(current)!;
  const template = current === "zh-CN" ? source : Object.hasOwn(catalog, source) ? catalog[source] : Object.hasOwn(messages, source) ? messages[source] : source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? "") : match);
}
/** Lazily rebuild module-level label maps and command catalogs when locale changes. */
export function localized<T extends object>(factory: () => T): T {
  let language = current;
  let value = factory();
  const read = () => { if (language !== current) { language = current; value = factory(); } return value; };
  return new Proxy(value, {
    get: (_target, property) => Reflect.get(read(), property),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) => Reflect.getOwnPropertyDescriptor(read(), property),
    has: (_target, property) => Reflect.has(read(), property),
  });
}

const originals = new Map(Object.entries(messages).map(([source, translated]) => [translated, source]));
const systemCache = new Map<string, string>();
/** Translate system notices received from the API or already held in component state. */
export function systemText(value: string | null | undefined): string {
  if (!value) return value ?? "";
  const cacheKey = `${current}\0${value}`;
  const cached = systemCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const original = originals.get(value) ?? value;
  if (Object.hasOwn(messages, original)) return t(original);
  for (const entry of patterns) {
    const match = entry.pattern.exec(value);
    if (!match) continue;
    const values: string[] = [];
    entry.slots.forEach((slot, index) => { values[slot] = match[index + 1]; });
    const result = t(entry.source, ...values);
    if (systemCache.size >= 512) systemCache.clear();
    systemCache.set(cacheKey, result);
    return result;
  }
  return value;
}

function pattern(template: string) {
  const slots: number[] = [];
  const parts = template.split(/(\{\d+\})/g).map(part => {
    if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return "([\\s\\S]*?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { pattern: new RegExp("^" + parts.join("") + "$"), slots };
}
const patterns = Object.entries(messages).filter(([source]) => /\{\d+\}/.test(source)).flatMap(([source, translated]) => [
  { source, ...pattern(source) }, { source, ...pattern(translated) },
]);
function registerSystemMessages(catalog: Catalog) {
  for (const [source, translated] of Object.entries(catalog)) {
    if (!Object.hasOwn(messages, source)) continue;
    originals.set(translated, source);
    if (/\{\d+\}/.test(source)) patterns.push({ source, ...pattern(translated) });
  }
  systemCache.clear();
}
updateDocument();
// main waits for this before rendering. A failed download preserves the saved
// preference, uses the English fallback, and can be retried in the picker.
export const localeReady = catalogs.has(preferred) ? Promise.resolve() : loadLocale(preferred).then(() => {
  if (selection === 0) activate(preferred, false);
}).catch(() => undefined);

/** Localized counts, including English singular nouns. */
export function count(value: number, unit: CountUnit): string { return formatCount(value, unit, current); }
/** CJK text joins without the word separator used by Latin and Korean text. */
export const wordSpace = () => ["zh-CN", "zh-TW", "ja"].includes(current) ? "" : " ";
