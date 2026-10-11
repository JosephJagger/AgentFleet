// Compare the update route used by hosts with the panel's expected release.
export function createAgentReleaseStatus(expected: () => Promise<{agentManifestVersion:string|null}>, origin:string, fetcher:typeof fetch=fetch) {
  let cached: Promise<{status:string;expectedVersion:string|null;publicVersion:string|null;checkedAt:string}> | undefined;
  let expires=0;
  return () => {
    if (cached && Date.now()<expires) return cached;
    expires=Date.now()+30_000;
    cached=(async()=>{
      const {agentManifestVersion:expectedVersion}=await expected();
      let publicVersion:string|null=null;
      try {
        const response=await fetcher(new URL('/downloads/manifest.json',origin),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
        if (!response.ok) throw new Error('unavailable');
        const raw=await response.text();
        if(raw.length>1_000_000) throw new Error('oversize');
        const m=JSON.parse(raw);
        if(m.schemaVersion!==1 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(m.version) || !m.artifacts || !Object.keys(m.artifacts).length) throw new Error('invalid');
        publicVersion=m.version;
      } catch { /* Unavailable is not up to date. */ }
      return {status:!publicVersion || !expectedVersion?'unavailable':publicVersion===expectedVersion?'ready':'mismatch',expectedVersion,publicVersion,checkedAt:new Date().toISOString()};
    })();
    return cached;
  };
}
