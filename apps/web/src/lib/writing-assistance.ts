import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type WritingEntry = { id: string; phrase: string; replacement: string; scope: "personal" | "project"; status: "candidate" | "active"; uses: number; source_session: string | null; source_event: string | null };
export type WritingMemoryState = { enabled: boolean; scope: "personal" | "project"; entries: WritingEntry[] };
export type WritingAISettings = { endpoint: string; model: string; enabled: boolean; hasKey: boolean; configured: boolean };

export function useWritingMemory(owner: string, sessionId?: string, revision?: string) {
  const key = `${owner}:${sessionId ?? ""}`;
  const [state, setState] = useState<{key:string; value:WritingMemoryState}>();
  const [error, setError] = useState<{key:string; message:string}>();
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!sessionId) return;
    try {
      const value = await api.writingMemory(sessionId, signal);
      if (!signal?.aborted) { setState({key,value}); setError(undefined); }
    } catch { if (!signal?.aborted) setError({key,message:"词库暂不可用，基础补全仍可使用"}); }
  }, [key, sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void refresh(controller.signal), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [refresh, revision]);
  return { value: state?.key === key ? state.value : undefined, error: error?.key === key ? error.message : "", refresh };
}
