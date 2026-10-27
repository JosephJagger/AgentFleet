/** Public, bounded contracts shared by the control plane, connection service and web. */
export type ManagedProvider = 'claude' | 'grok';
export interface ManagedArtifact { integrity: string; size: number; }
export interface ManagedRelease {
  id: string; provider: ManagedProvider; version: string; checkedAt: string;
  artifacts: Record<string, ManagedArtifact>;
}
export interface ManagedChannel {
  provider: ManagedProvider; revision: number; phase: 'idle' | 'checking' | 'ready' | 'failed';
  candidate?: ManagedRelease | undefined; target?: ManagedRelease | undefined; previous?: ManagedRelease | undefined;
  checkedAt?: string; error?: string | undefined;
  history: {at: string; action: 'publish' | 'rollback'; version: string}[];
}
export type ManagedPhase = 'accepted' | 'downloading' | 'verifying' | 'waiting_idle' | 'activating' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface ManagedUpdate {
  revision: number; operationId: string; provider: ManagedProvider; phase: ManagedPhase;
  targetVersion: string; releaseId: string; updatedAt: string; error?: string;
  received?: number; total?: number;
}
export function parseManagedUpdate(value: unknown): ManagedUpdate | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as ManagedUpdate;
  if (!['claude','grok'].includes(v.provider) || !Number.isSafeInteger(v.revision) || v.revision < 0 ||
      !['accepted','downloading','verifying','waiting_idle','activating','succeeded','failed','cancelled','unknown'].includes(v.phase) ||
      typeof v.operationId !== 'string' || v.operationId.length > 200 || typeof v.targetVersion !== 'string' || v.targetVersion.length > 40 || !/^[a-f0-9]{64}$/.test(v.releaseId) ||
      !/^\d+\.\d+\.\d+$/.test(v.targetVersion) || !Number.isFinite(Date.parse(v.updatedAt))) return;
  return {revision:v.revision,operationId:v.operationId,provider:v.provider,phase:v.phase,targetVersion:v.targetVersion,releaseId:v.releaseId,updatedAt:v.updatedAt,
    ...(typeof v.error === 'string' ? {error:v.error.slice(0,300)} : {}),
    ...(Number.isSafeInteger(v.received) && Number.isSafeInteger(v.total) && v.total! > 0 && v.total! <= 536870912 && v.received! >= 0 && v.received! <= v.total! ? {received:v.received,total:v.total} : {})};
}
export function parseManagedRelease(value: unknown): ManagedRelease {
  const v = value as ManagedRelease;
  if (!v || typeof v.version !== 'string' || v.version.length > 40 || !['claude','grok'].includes(v.provider) || !/^[a-f0-9]{64}$/.test(v.id) || !/^\d+\.\d+\.\d+$/.test(v.version) ||
      !Number.isFinite(Date.parse(v.checkedAt)) || !v.artifacts || typeof v.artifacts !== 'object') throw new Error('Invalid managed release');
  const artifacts: Record<string, ManagedArtifact> = {};
  for (const [platform, a] of Object.entries(v.artifacts)) {
    if (!/^(linux|darwin|win32)-(x64|arm64)(-musl)?$/.test(platform) || !a || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 536870912 ||
        !(v.provider === 'claude' ? /^[a-f0-9]{64}$/.test(a.integrity) : /^sha512-[A-Za-z0-9+/]{86}==$/.test(a.integrity))) throw new Error('Invalid managed artifact');
    artifacts[platform] = {size:a.size,integrity:a.integrity};
  }
  if (!Object.keys(artifacts).length || Object.keys(artifacts).length > 10) throw new Error('Missing managed artifacts');
  return {id:v.id,provider:v.provider,version:v.version,checkedAt:v.checkedAt,artifacts};
}

export interface ManagedEligibility {state:'ready'|'managed'|'not_installed'|'login_required'|'unverified';checkedAt:string;}
export function parseManagedEligibility(value:unknown):ManagedEligibility|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as ManagedEligibility;
  if(!['ready','managed','not_installed','login_required','unverified'].includes(v.state)||typeof v.checkedAt!=='string'||v.checkedAt.length>40||!Number.isFinite(Date.parse(v.checkedAt))||Date.parse(v.checkedAt)>Date.now()+60000)return;
  return {state:v.state,checkedAt:v.checkedAt};
}
