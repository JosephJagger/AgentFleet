import { useEffect, useState } from "react";
import { api } from "./api";
import type { PromptCompletion } from "./prompt-completions";

export type NLPSuggestion = { label: string; insertText: string; replaceStart: number; replaceEnd: number; intent: string; source?: "lexical" | "semantic"; domain?: string };
export function eligibleNLPDraft(draft: string) {
  return draft.length >= 4 && draft.length <= 2000 && /[\u3400-\u9fffA-Za-z]/.test(draft) && !draft.trimStart().startsWith("/")
    && !/[`{}]|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:api.?key|password|secret|token|密码|密钥)\s*[:=]|\b(?:sk|ghp|gho|xoxb)-[\w-]+|Bearer\s+|-----BEGIN|\b[A-Za-z0-9_+/=-]{32,}\b/i.test(draft);
}

export function useChineseNLP(owner: string, sessionId: string | undefined, draft: string, enabled: boolean) {
  const key = JSON.stringify([owner, sessionId, draft]);
  const [result, setResult] = useState<{ key: string; suggestions: PromptCompletion[] }>();
  useEffect(() => {
    if (!enabled || !sessionId || !eligibleNLPDraft(draft)) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), 2500);
      void Promise.resolve().then(() => api.writingNLP(sessionId, draft, controller.signal)).then(response => {
        if (controller.signal.aborted) return;
        const suggestions = (Array.isArray(response.suggestions) ? response.suggestions : []).filter(item =>
          typeof item.label === "string" && item.label.length <= 500 && item.insertText === item.label
          && Number.isInteger(item.replaceStart) && item.replaceStart >= 0 && item.replaceStart < draft.length && item.replaceEnd === draft.length
        ).slice(0, 2).map(item => ({ ...item, detail: item.source === "semantic" ? "本地语义建议" : "本地 NLP 建议", kind: "rewrite" as const }));
        setResult({ key, suggestions });
      }).catch(() => { /* Local completions keep working when the backend is unavailable. */ })
        .finally(() => clearTimeout(timeout));
    }, 600);
    return () => { clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [key, sessionId, draft, enabled]);
  return enabled && result?.key === key ? result.suggestions : [];
}

/** Append delayed choices so an existing keyboard selection never changes meaning. */
export function mergeWritingSuggestions(local: PromptCompletion[], remote: PromptCompletion[]) {
  const additions = remote.filter(item => !local.some(existing => existing.label === item.label));
  return [...local.slice(0, 5), ...additions.slice(0, 2)];
}
