#!/usr/bin/env node
// Generate schemas without starting a session, then compare the checked-in RPC allowlist.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [executable, output] = process.argv.slice(2);
if (!executable || !output) throw Error('Usage: node scripts/audit-codex-coverage.mjs <codex-executable> <output.json>');
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'agentfleet-schema-audit-'));
try {
  const version = execFileSync(resolve(executable), ['--version'], { encoding:'utf8' }).trim();
  for (const flavor of ['default','experimental']) execFileSync(resolve(executable), ['app-server','generate-json-schema', ...(flavor === 'experimental' ? ['--experimental'] : []), '--out',join(stage,flavor)], {stdio:'pipe'});
  const read = (flavor, name) => JSON.parse(readFileSync(join(stage,flavor,name+'.json'),'utf8'));
  const methods = (flavor, name) => [...new Set(read(flavor,name).oneOf.flatMap(v=>v.properties?.method?.enum??[]))].sort();
  const standard = methods('default','ClientRequest'); const all = methods('experimental','ClientRequest');
  const source = readFileSync(join(root,'apps/local-agent/src/app-server.ts'),'utf8');
  const allowed = [...new Set([...source.split('const APP_SERVER_METHODS = new Set([')[1].split(']);')[0].matchAll(/"([^"]+)"/g)].map(m=>m[1]))].sort();
  const result = { version, note:'Allowlist coverage is not product completeness or evidence of native end-to-end verification.', counts:{standard:standard.length,includingExperimental:all.length,allowed:allowed.length},
    standardAllowed:standard.filter(m=>allowed.includes(m)), experimentalAllowed:all.filter(m=>!standard.includes(m)&&allowed.includes(m)),
    standardMissing:standard.filter(m=>!allowed.includes(m)), experimentalMissing:all.filter(m=>!standard.includes(m)&&!allowed.includes(m)),
    unknownAllowed:allowed.filter(m=>!all.includes(m)), serverRequests:methods('experimental','ServerRequest'),
    nativeParameterNames:Object.fromEntries(['ThreadStartParams','ThreadResumeParams','TurnStartParams','ThreadSettingsUpdateParams','ThreadRealtimeStartParams','ConfigBatchWriteParams'].map(name=>[name,Object.keys(read('experimental','v2/'+name).properties??{}).sort()])) };
  writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result.counts));
  if (result.unknownAllowed.length) throw Error('Allowlisted methods missing from native schema: '+result.unknownAllowed.join(', '));
} finally { rmSync(stage,{recursive:true,force:true}); }
