import { setTimeout as pause } from "node:timers/promises";

/** Retry only transport failures of read-only update downloads, never activation. */
export async function retryUpdateDownload<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal?.throwIfAborted();
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const retryable = error instanceof Error && (error.name === "TimeoutError"
        || /^(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(cause?.code ?? "")
        || /fetch failed|terminated/i.test(error.message));
      if (!retryable || attempt >= 2) {
        if (retryable && error instanceof Error) throw new Error(`更新下载连接失败（已尝试 3 次${cause?.code ? `，${cause.code}` : ""}），保留原版本，稍后自动检查`, { cause: error });
        throw error;
      }
      await pause(250 * 2 ** attempt, undefined, signal ? { signal } : undefined);
    }
  }
}
