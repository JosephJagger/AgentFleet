import { ApiError } from "./types";
import { t } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type WritingEntry = { id: string; phrase: string; replacement: string; scope: "personal" | "project"; status: "candidate" | "active"; uses: number; source_session: string | null; source_event: string | null; source_role?: string | null };
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

export function writingAIErrorMessage(error: unknown) {
  const messages: Record<string,string> = {
    WRITING_AI_AUTH: "AI 服务拒绝了密钥，请检查密钥与访问权限",
    WRITING_AI_BALANCE: "AI 服务余额不足，请检查服务账户",
    WRITING_AI_RATE_LIMIT: "AI 请求过于频繁，请稍后重试",
    WRITING_AI_CONFIG: "AI 服务不接受当前请求，请检查基础地址、模型名称与接口兼容性",
    WRITING_AI_TRUNCATED: "AI 返回内容被截断，请缩短草稿后重试",
    WRITING_AI_TIMEOUT: "AI 优化超时，请稍后重试",
    WRITING_AI_FORMAT: "AI 未返回有效的建议格式，请重试",
    INVALID_WRITING_TEXT: "草稿过长或包含敏感信息，请精简后重试",
    WRITING_AI_DISABLED: "请先在设置中配置 AI 理解；基础补全与自动学习仍可使用",
  };
  return t(error instanceof ApiError && error.code && messages[error.code] || "AI 建议暂不可用，基础补全仍可使用");
}
