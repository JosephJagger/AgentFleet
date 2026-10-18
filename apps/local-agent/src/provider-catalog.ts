/** Stable wire IDs. Kept identical in the three independently built applications. */
export const PROVIDER_NAMES = { codex: 'Codex', claude: 'Claude Code', qwen: 'Qwen Code', kimi: 'Kimi Code', cursor: 'Cursor', codebuddy: 'CodeBuddy Code', grok: 'Grok Build' } as const;
export type ProviderId = keyof typeof PROVIDER_NAMES;
export const PROVIDER_IDS = Object.keys(PROVIDER_NAMES) as ProviderId[];
export const ACP_PROVIDER_IDS = ['qwen', 'kimi', 'cursor', 'codebuddy', 'grok'] as const;
export type AcpProviderId = typeof ACP_PROVIDER_IDS[number];
export function isProviderId(value: unknown): value is ProviderId { return typeof value === 'string' && Object.hasOwn(PROVIDER_NAMES, value); }
export function isAcpProvider(value: unknown): value is AcpProviderId { return ACP_PROVIDER_IDS.some(id => id === value); }
export function providerName(value: unknown): string { return isProviderId(value) ? PROVIDER_NAMES[value] : 'Unknown agent'; }
export interface ProviderCapabilities {
  discover: boolean; history: boolean; create: boolean; resume: boolean;
  prompt: boolean; cancel: boolean; approval: boolean; input: boolean;
  steer: boolean; images: boolean; files: boolean; models: boolean; usage: boolean;
}
export interface ProviderAvailability {
  installed: boolean; version: string | null; state: 'missing' | 'checking' | 'ready' | 'login_required' | 'unverified' | 'error';
  checkedAt: string; capabilities: ProviderCapabilities; error?: string;
}
export function unavailableCapabilities(): ProviderCapabilities {
  return {discover:false,history:false,create:false,resume:false,prompt:false,cancel:false,approval:false,input:false,steer:false,images:false,files:false,models:false,usage:false};
}

/** Accept only bounded, explicitly advertised runtime information. */
export function parseProviderAvailability(value: unknown): ProviderAvailability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const capabilities = unavailableCapabilities();
  const source = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities as Record<string, unknown> : {};
  for (const key of Object.keys(capabilities) as Array<keyof ProviderCapabilities>) capabilities[key] = source[key] === true;
  const state = ['missing','checking','ready','login_required','unverified','error'].includes(String(raw.state)) ? raw.state as ProviderAvailability['state'] : 'unverified';
  return { installed: raw.installed === true, version: typeof raw.version === 'string' ? raw.version.slice(0,100) : null,
    state, checkedAt: typeof raw.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt)) ? raw.checkedAt : '',
    capabilities: state === 'ready' ? capabilities : unavailableCapabilities(),
    ...(typeof raw.error === 'string' ? {error: raw.error.slice(0,300)} : {}) };
}

export function supportsProviderCommand(value: unknown, command: string, hasNativeSession = true): boolean {
  const status = parseProviderAvailability(value);
  const capability: Record<string, keyof ProviderCapabilities> = {'thread.claim':'resume','thread.release':'resume','turn.start':hasNativeSession?'prompt':'create','turn.queue':'prompt','turn.steer':'steer','turn.cancel':'cancel','approval.decide_once':'approval','input.respond':'input'};
  const key = capability[command];
  return Boolean(key && status?.installed && status.state === 'ready' && status.capabilities[key]);
}

/** Provider-specific input support; never borrow another provider's catalog. */
export function supportsImageInput(provider:unknown, codexImageInput:boolean, availability:unknown):boolean {
  if (provider === 'codex') return codexImageInput;
  if (provider === 'claude') return true;
  if (!isAcpProvider(provider)) return false;
  const status=parseProviderAvailability(availability);
  return status?.installed === true && status.state === 'ready' && status.capabilities.images;
}
