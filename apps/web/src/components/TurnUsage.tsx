import { locale, t } from "../i18n";

/** A quiet metadata row; zero is a recorded value, not missing data. */
export function TurnUsage({ tokens, cacheHitRate }: { tokens?: number | null; cacheHitRate?: number | null }) {
  const total = tokens == null ? t("用量未记录") : `${new Intl.NumberFormat(locale()).format(tokens)} tokens`;
  const cache = cacheHitRate == null ? null : t("命中 {0}%", new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(cacheHitRate));
  const description = [tokens == null ? t("本轮 token 未记录") : t("本轮消耗 {0} tokens", new Intl.NumberFormat(locale()).format(tokens)), cacheHitRate == null ? t("缓存命中率未记录") : t("缓存命中率 {0}%", new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(cacheHitRate))].join(" · ");
  return <span className="timeline-event__turn-tokens" role="group" aria-label={description} title={description}><span aria-hidden="true">{total}{cache && <> · {cache}</>}</span></span>;
}
