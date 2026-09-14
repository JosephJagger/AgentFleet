import { t } from "../i18n";

export function SettingsPagination({ page, pages, onChange, label }: { page: number; pages: number; onChange: (page: number) => void; label: string }) {
  if (pages <= 1) return null;
  return <nav className="settings-pagination" aria-label={label}>
    <button type="button" className="button button--quiet" disabled={page === 0} onClick={() => onChange(page - 1)}>{t("上一页")}</button>
    <span aria-live="polite">{t("第 {0} / {1} 页", page + 1, pages)}</span>
    <button type="button" className="button button--quiet" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>{t("下一页")}</button>
  </nav>;
}
