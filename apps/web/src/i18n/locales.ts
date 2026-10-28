/** Native names stay recognizable even when the current interface is unfamiliar. */
export const localeOptions = [
  { value: "en", name: "English", compact: "English" },
  { value: "zh-CN", name: "简体中文", compact: "简体中文" },
  { value: "zh-TW", name: "繁體中文", compact: "繁體中文" },
  { value: "ja", name: "日本語", compact: "日本語" },
  { value: "ko", name: "한국어", compact: "한국어" },
  { value: "de", name: "Deutsch", compact: "Deutsch" },
  { value: "fr", name: "Français", compact: "Français" },
  { value: "es", name: "Español", compact: "Español" },
  { value: "it", name: "Italiano", compact: "Italiano" },
  { value: "nl", name: "Nederlands", compact: "Nederlands" },
  { value: "pt-BR", name: "Português (Brasil)", compact: "Português" },
] as const;
export type Locale = typeof localeOptions[number]["value"];
export const isLocale = (value: unknown): value is Locale => localeOptions.some(option => option.value === value);

/** Match browser language preferences, including script-specific Chinese tags. */
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase().replace(/_/g, "-");
    if (tag === "zh" || tag.startsWith("zh-")) {
      if (tag.includes("hans")) return "zh-CN";
      if (tag.includes("hant") || /-(tw|hk|mo)(-|$)/.test(tag)) return "zh-TW";
      return "zh-CN";
    }
    const base = tag.split("-")[0];
    if (base === "pt") return "pt-BR";
    if (isLocale(base)) return base;
  }
  return "en";
}

export const languageLoadError: Record<Locale, string> = {
  en: "Couldn’t load this language. Please try again.",
  "zh-CN": "语言包加载失败，请重试。", "zh-TW": "無法載入語言套件，請再試一次。",
  ja: "言語を読み込めませんでした。もう一度お試しください。", ko: "언어를 불러오지 못했어요. 다시 시도해 주세요.",
  de: "Die Sprache konnte nicht geladen werden. Bitte erneut versuchen.",
  fr: "Impossible de charger cette langue. Réessayez.", es: "No se ha podido cargar el idioma. Inténtalo de nuevo.",
  it: "Impossibile caricare la lingua. Riprova.", nl: "De taal kon niet worden geladen. Probeer het opnieuw.",
  "pt-BR": "Não foi possível carregar o idioma. Tente novamente.",
};

export type CountUnit = "个项目" | "个会话" | "台主机" | "个文件" | "天";
const unitOrder: CountUnit[] = ["个项目", "个会话", "台主机", "个文件", "天"];
const countForms: Record<Locale, readonly (string | readonly [string, string])[]> = {
  en: [["{0} project", "{0} projects"], ["{0} session", "{0} sessions"], ["{0} host", "{0} hosts"], ["{0} file", "{0} files"], ["{0} day", "{0} days"]],
  "zh-CN": ["{0} 个项目", "{0} 个会话", "{0} 台主机", "{0} 个文件", "{0} 天"],
  "zh-TW": ["{0} 個專案", "{0} 個工作階段", "{0} 台主機", "{0} 個檔案", "{0} 天"],
  ja: ["{0} プロジェクト", "{0} セッション", "{0} 台のホスト", "{0} ファイル", "{0} 日"],
  ko: ["프로젝트 {0}개", "세션 {0}개", "호스트 {0}대", "파일 {0}개", "{0}일"],
  de: [["{0} Projekt", "{0} Projekte"], ["{0} Sitzung", "{0} Sitzungen"], ["{0} Host", "{0} Hosts"], ["{0} Datei", "{0} Dateien"], ["{0} Tag", "{0} Tage"]],
  fr: [["{0} projet", "{0} projets"], ["{0} session", "{0} sessions"], ["{0} hôte", "{0} hôtes"], ["{0} fichier", "{0} fichiers"], ["{0} jour", "{0} jours"]],
  es: [["{0} proyecto", "{0} proyectos"], ["{0} sesión", "{0} sesiones"], ["{0} equipo", "{0} equipos"], ["{0} archivo", "{0} archivos"], ["{0} día", "{0} días"]],
  it: [["{0} progetto", "{0} progetti"], ["{0} sessione", "{0} sessioni"], ["{0} host", "{0} host"], ["{0} file", "{0} file"], ["{0} giorno", "{0} giorni"]],
  nl: [["{0} project", "{0} projecten"], ["{0} sessie", "{0} sessies"], ["{0} host", "{0} hosts"], ["{0} bestand", "{0} bestanden"], ["{0} dag", "{0} dagen"]],
  "pt-BR": [["{0} projeto", "{0} projetos"], ["{0} sessão", "{0} sessões"], ["{0} host", "{0} hosts"], ["{0} arquivo", "{0} arquivos"], ["{0} dia", "{0} dias"]],
};
export function formatCount(value: number, unit: CountUnit, language: Locale): string {
  const forms = countForms[language][unitOrder.indexOf(unit)];
  const template = typeof forms === "string" ? forms : forms[new Intl.PluralRules(language).select(value) === "one" ? 0 : 1];
  return template.replace("{0}", new Intl.NumberFormat(language).format(value));
}
