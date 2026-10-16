import { providerName } from "./provider-catalog";
export const agentName = (provider?: string) => providerName(provider ?? "codex");
