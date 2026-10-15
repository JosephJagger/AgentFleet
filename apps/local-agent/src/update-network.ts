import { setTimeout as pause } from "node:timers/promises";

/** Retry only transport failures of read-only update downloads, never activation. */
export async function retryUpdateDownload<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await read();
      if (result instanceof Response && (result.status === 429 || result.status >= 500)) {
        const retryAfter = result.headers.get("retry-after");
        await result.body?.cancel();
        const error = new Error(`更新下载 HTTP ${result.status}`) as Error & { retryAfterMs?: number };
        const milliseconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
        error.retryAfterMs = Math.max(0, Math.min(30_000, milliseconds || 0));
        throw error;
      }
      return result;
    }
    catch (error) {
      signal?.throwIfAborted();
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const retryable = error instanceof Error && (error.name === "TimeoutError"
        || /^(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(cause?.code ?? "")
        || /fetch failed|terminated|HTTP (?:429|5\d\d)\b/i.test(error.message));
      if (!retryable || attempt >= 2) {
        if (retryable && error instanceof Error) throw new Error(`更新下载暂时失败（已尝试 3 次${cause?.code ? `，${cause.code}` : ""}），保留原版本，稍后自动检查`, { cause: error });
        throw error;
      }
      await pause(Math.max(250 * 2 ** attempt, (error as Error & { retryAfterMs?: number }).retryAfterMs ?? 0), undefined, signal ? { signal } : undefined);
    }
  }
}
