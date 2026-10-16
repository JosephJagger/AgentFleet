import {isAcpProvider, type AcpProviderId, type ProviderId} from './provider-catalog.js';
import {AgentError} from './errors.js';
export function encodeProviderThread(provider: AcpProviderId, id: string): string {
  if (!id || Buffer.byteLength(id) > 160 || /[\x00-\x1f\x7f]/u.test(id)) throw new AgentError('PROVIDER_ID_INVALID','Invalid native session identity');
  return `acp_${provider}_${Buffer.from(id).toString('base64url')}`;
}
export function decodeProviderThread(id: string): {provider:AcpProviderId;nativeId:string} | null {
  if (!id.startsWith('acp_')) return null;
  const match = /^acp_([a-z]+)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match || !isAcpProvider(match[1])) throw new AgentError('PROVIDER_ID_INVALID','Unknown provider identity');
  const nativeId = Buffer.from(match[2]!, 'base64url').toString('utf8');
  if (encodeProviderThread(match[1],nativeId) !== id) throw new AgentError('PROVIDER_ID_INVALID','Noncanonical provider identity');
  return {provider:match[1],nativeId};
}
export function threadProvider(id: string): ProviderId { return decodeProviderThread(id)?.provider ?? (id.startsWith('claude_') ? 'claude' : 'codex'); }
