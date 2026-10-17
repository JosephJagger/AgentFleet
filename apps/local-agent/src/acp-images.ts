import {parseImages} from './images.js';
import {isRecord} from './util.js';
import type {AcpProviderId} from './provider-catalog.js';

/** Prefer the negotiated capability. Grok 1.0.62 omits it despite accepting
 * ACP image blocks (official prompt_parser.rs and an isolated two-image probe).
 * Keep the exception exact: unknown versions must advertise support themselves. */
export function acpImageInput(provider:AcpProviderId, version:string, initialize:unknown):boolean {
  if (!isRecord(initialize) || !isRecord(initialize.agentCapabilities)) return false;
  const prompt = initialize.agentCapabilities.promptCapabilities;
  if (isRecord(prompt) && prompt.image === true) return true;
  return provider === 'grok' && /^grok 1\.0\.62(?:\s|$)/.test(version)
    && isRecord(initialize._meta) && initialize._meta.grokShell === true;
}

export function acpImageBlocks(images:unknown):Array<{type:'image';mimeType:string;data:string}> {
  return parseImages(images).map(url => {
    const comma=url.indexOf(',');
    return {type:'image',mimeType:url.slice(5,url.indexOf(';')),data:url.slice(comma+1)};
  });
}
