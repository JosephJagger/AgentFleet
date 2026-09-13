import { useState } from "react";

type CompletionPreferences = { terms: boolean; suggestions: boolean };
const defaults: CompletionPreferences = { terms: true, suggestions: true };

export function useCompletionPreferences(owner: string, sessionId?: string) {
  const key = `agentfleet.completions:${encodeURIComponent(owner)}:${encodeURIComponent(sessionId ?? "")}`;
  const [values, setValues] = useState<Record<string, CompletionPreferences>>({});
  let stored = defaults;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    stored = { terms: parsed?.terms !== false, suggestions: parsed?.suggestions !== false };
  } catch { /* Use defaults when storage is unavailable or invalid. */ }
  const preferences = values[key] ?? stored;
  function update(next: Partial<CompletionPreferences>) {
    const value = { ...preferences, ...next };
    setValues(current => ({ ...current, [key]: value }));
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep this page usable without storage. */ }
  }
  return [preferences, update] as const;
}
