import { AgentError } from "./errors.js";

type Rpc = (method: string, params: Record<string, unknown> | null) => Promise<unknown>;
const expired = (error: unknown) => error instanceof Error && /\btoken_expired\b|authentication token has expired/i.test(error.message);
const reauthenticate = () => new AgentError("CODEX_AUTH_EXPIRED", "Codex login has expired. Reconnect the ChatGPT account on this host, then retry.");

// Only retry account reads. Never replay a turn, a reset-card consumption, or
// another mutation. Codex owns credential storage and refresh-token rotation.
export function recoverCodexAccountReads(rpc: Rpc): Rpc {
  let refresh: Promise<void> | undefined;
  return async (method, params) => {
    try { return await rpc(method, params); }
    catch (error) {
      if (!["account/rateLimits/read", "account/usage/read"].includes(method) || !expired(error)) throw error;
    }
    if (!refresh) {
      refresh = (async () => {
        const value = await rpc("account/read", { refreshToken: true });
        if (value && typeof value === "object" && "account" in value && value.account === null) throw reauthenticate();
      })().finally(() => { refresh = undefined; });
    }
    await refresh;
    try { return await rpc(method, params); }
    catch (error) { if (expired(error)) throw reauthenticate(); throw error; }
  };
}
