/** This request crosses a trust boundary; never accept paths, URLs or shell commands. */
export type ProviderRuntimeRequest = { action: 'check' } | { action: 'configure'; provider: 'claude'; mode: 'host' | 'pinned' | 'auto'; expectedRevision: number } | { action: 'rollback'; provider: 'claude'; expectedRevision: number };
export function parseProviderRuntimeRequest(value: unknown): ProviderRuntimeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider runtime request');
  const v = value as Record<string, unknown>;
  if (v.action === 'check' && Object.keys(v).length === 1) return {action:'check'};
  if (v.provider !== 'claude' || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 0) throw new Error('Invalid provider runtime revision');
  if (v.action === 'rollback' && Object.keys(v).length === 3) return {action:'rollback',provider:'claude',expectedRevision:Number(v.expectedRevision)};
  if (v.action === 'configure' && Object.keys(v).length === 4 && ['host','pinned','auto'].includes(String(v.mode))) return {action:'configure',provider:'claude',mode:v.mode as 'host'|'pinned'|'auto',expectedRevision:Number(v.expectedRevision)};
  throw new Error('Unsupported provider runtime request');
}
export interface ManagedProviderRelease {version:string;sha256:string;size:number;platform:string;checkedAt:string;sdkVersion:string;}
export interface ProviderRuntimeState {
  revision:number;mode:'host'|'pinned'|'auto';current?:ManagedProviderRelease;previous?:ManagedProviderRelease;
  hostCompatibility?:{version:string;checkedAt:string;state:'protocol_checked'|'unverified';sdkVersion:string};
  checkedAt?:string;stableVersion?:string;phase?:'idle'|'waiting_idle'|'checking'|'ready'|'blocked';error?:string;failedVersion?:string;
}
/** Bounded public status; no binary paths, environment or credentials cross the relay. */
export function parseProviderRuntimeState(value:unknown):ProviderRuntimeState|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const v=value as Record<string,unknown>;
  if(!Number.isSafeInteger(v.revision)||Number(v.revision)<0||!['host','pinned','auto'].includes(String(v.mode)))return undefined;
  const validVersion=(s:unknown):s is string=>typeof s==='string'&&s.length<=40&&/^\d+\.\d+\.\d+$/.test(s);
  const result:ProviderRuntimeState={revision:Number(v.revision),mode:v.mode as ProviderRuntimeState['mode']};
  for(const key of ['current','previous'] as const) {
    if(v[key]===undefined)continue;const r=v[key] as ManagedProviderRelease;
    if(!r||typeof r!=='object'||!validVersion(r.version)||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<=0||r.size>512*1024*1024||typeof r.platform!=='string'||!/^(linux|darwin|win32)-(x64|arm64)(-musl)?$/.test(r.platform)||typeof r.checkedAt!=='string'||r.checkedAt.length>40||!Number.isFinite(Date.parse(r.checkedAt))||!validVersion(r.sdkVersion))return undefined;
    result[key]={version:r.version,sha256:r.sha256,size:r.size,platform:r.platform,checkedAt:r.checkedAt,sdkVersion:r.sdkVersion};
  }
  if(typeof v.checkedAt==='string'&&v.checkedAt.length<=40&&Number.isFinite(Date.parse(v.checkedAt)))result.checkedAt=v.checkedAt;
  for(const key of ['stableVersion','failedVersion'] as const)if(typeof v[key]==='string'&&(v[key]===''||validVersion(v[key])))result[key]=v[key];
  if(typeof v.error==='string')result.error=v.error.slice(0,500);
  if(['idle','waiting_idle','checking','ready','blocked'].includes(String(v.phase)))result.phase=v.phase as NonNullable<ProviderRuntimeState['phase']>;
  const h=v.hostCompatibility as ProviderRuntimeState['hostCompatibility'];
  if(h&&typeof h==='object'&&validVersion(h.version)&&validVersion(h.sdkVersion)&&['protocol_checked','unverified'].includes(h.state)&&typeof h.checkedAt==='string'&&h.checkedAt.length<=40&&Number.isFinite(Date.parse(h.checkedAt)))result.hostCompatibility={version:h.version,sdkVersion:h.sdkVersion,state:h.state,checkedAt:h.checkedAt};
  return result;
}
