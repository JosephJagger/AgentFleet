import type { ReactNode } from "react";

/** Real buttons retain native keyboard behavior; panels stay mounted to preserve drafts. */
export function SettingsSections<T extends string>({ label, value, onChange, items }: {
  label: string; value: T; onChange: (value: T) => void;
  items: { id: T; label: string; icon?: ReactNode; description?: string }[];
}) {
  return <nav className="settings-sections" aria-label={label}>{items.map(item => <button key={item.id} type="button" aria-label={item.label} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>
    {item.icon}<span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
  </button>)}</nav>;
}
