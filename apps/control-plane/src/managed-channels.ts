import { createHash } from 'node:crypto';
import { readChannelJson, writeChannelJson } from './runtime-channel.js';
import { parseManagedRelease, type ManagedChannel, type ManagedProvider, type ManagedRelease, type ManagedArtifact } from './managed-provider.js';
import { verifyDetachedSignature } from './openpgp-verify.js';
import { AppError } from './errors.js';

const base = 'https://downloads.claude.ai/claude-code-releases';
export async function boundedFetch(url: string, fetcher = fetch): Promise<Buffer> {
  const r = await fetcher(url, {redirect:'error',signal:AbortSignal.timeout(20_000)});
  if (!r.ok || !r.body) throw new Error('Official release service unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of r.body) { size += chunk.length; if (size > 512_000) throw new Error('Release metadata too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function discoverManagedRelease(provider: ManagedProvider, fetcher = fetch): Promise<ManagedRelease> {
  const read = (url:string) => boundedFetch(url,fetcher);
  const json = async (url:string) => JSON.parse((await read(url)).toString('utf8'));
  const artifacts: Record<string,ManagedArtifact> = {};
  let version: string;
  if (provider === 'claude') {
    version = (await read(`${base}/stable`)).toString('utf8').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid official version');
    const [manifest,signature] = await Promise.all([read(`${base}/${version}/manifest.json`),read(`${base}/${version}/manifest.json.sig`)]);
    verifyDetachedSignature(manifest,signature.toString('utf8'));
    const data = JSON.parse(manifest.toString('utf8'));
    if (data.version !== version) throw new Error('Manifest version mismatch');
    for (const [platform,raw] of Object.entries(data.platforms ?? {})) {
      if (!/^(linux|darwin|win32)-(x64|arm64)(-musl)?$/.test(platform)) continue;
      const a = raw as {checksum:string;size:number;binary:string};
      if (a.binary !== (platform.startsWith('win32') ? 'claude.exe' : 'claude')) throw new Error('Invalid official binary');
      artifacts[platform] = {integrity:a.checksum,size:a.size};
    }
  } else {
    const root = await json('https://registry.npmjs.org/@xai-official/grok/latest');
    version = root.version;
    if (root.name !== '@xai-official/grok' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid official package');
    await Promise.all(['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'].map(async platform => {
      const name = `@xai-official/grok-${platform}`;
      if (root.optionalDependencies?.[name] !== version) return;
      const data = await json(`https://registry.npmjs.org/${name}/${version}`);
      if (data.name !== name || data.version !== version || data.dist?.tarball !== `https://registry.npmjs.org/${name}/-/grok-${platform}-${version}.tgz`) throw new Error('Invalid official package artifact');
      artifacts[platform] = {integrity:data.dist.integrity,size:data.dist.unpackedSize};
    }));
  }
  const ordered = Object.fromEntries(Object.entries(artifacts).sort(([a],[b])=>a.localeCompare(b)));
  const id = createHash('sha256').update(JSON.stringify({provider,version,artifacts:ordered})).digest('hex');
  return parseManagedRelease({id,provider,version,artifacts:ordered,checkedAt:new Date().toISOString()});
}

/** Discovery never promotes a target; each publication binds the reviewed candidate's exact digest. */
export class ManagedChannels {
  private readonly checks = new Map<ManagedProvider,Promise<void>>();
  constructor(private readonly directory:string, private readonly discover=discoverManagedRelease) {}
  read(provider:ManagedProvider):ManagedChannel {
    const state=readChannelJson(this.directory,`${provider}-channel.json`,{provider,revision:0,phase:'idle',history:[]} as ManagedChannel);
    return state.phase==='checking'&&!this.checks.has(provider)?{...state,phase:'failed',error:'上次版本检查被中断，请重新检查'}:state;
  }
  private write(state:ManagedChannel) { writeChannelJson(this.directory,`${state.provider}-channel.json`,state); }
  async check(provider:ManagedProvider) {
    if (this.checks.has(provider)) return this.checks.get(provider);
    const work = (async()=>{
      const initial=this.read(provider);this.write({...initial,phase:'checking',error:undefined});
      try { const candidate=await this.discover(provider);this.write({...this.read(provider),candidate,phase:'ready',checkedAt:new Date().toISOString(),error:undefined}); }
      catch { this.write({...this.read(provider),phase:'failed',checkedAt:new Date().toISOString(),error:'官方版本检查未通过，现有托管目标保持不变'}); }
    })();
    this.checks.set(provider,work);
    try { await work; } finally {this.checks.delete(provider);}
  }
  control(provider:ManagedProvider,action:'publish'|'rollback',revision:number,releaseId:string) {
    const state=this.read(provider);
    if (this.checks.has(provider) || state.revision!==revision) throw new AppError(409,'PROVIDER_CHANNEL_CONFLICT','版本状态已变化，请刷新后重试');
    const target=action==='publish'?state.candidate:state.previous;
    if (!target || target.id!==releaseId) throw new AppError(409,'PROVIDER_TARGET_CHANGED','所选托管版本已变化，请重新查看');
    if (state.target?.id===target.id) return state;
    const next:ManagedChannel={...state,revision:state.revision+1,target,previous:state.target,
      history:[{at:new Date().toISOString(),action,version:target.version},...state.history].slice(0,30)};
    this.write(next);return next;
  }
  async stop() {await Promise.allSettled([...this.checks.values()]);}
}
