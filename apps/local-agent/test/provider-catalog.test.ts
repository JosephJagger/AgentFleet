import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeProviderThread,decodeProviderThread,threadProvider} from '../src/provider-identity.js';
import {PROVIDER_IDS,isProviderId,unavailableCapabilities} from '../src/provider-catalog.js';
test('Cursor discovery rejects Grok agent alias and continues to the actual Cursor CLI', {skip:process.platform==='win32'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'provider-vendor-'));
  const oldPath=process.env.PATH;
  t.after(async()=>{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});});
  await writeFile(join(dir,'agent'),'#!/bin/sh\nprintf "grok 1.0.62 [stable]\\n"\n',{mode:0o755});
  await writeFile(join(dir,'cursor-agent'),'#!/bin/sh\nprintf "Cursor Agent 1.2.3\\n"\n',{mode:0o755});
  process.env.PATH=dir;
  const {detectAcp}=await import('../src/acp-providers.js');
  const found=await detectAcp('cursor');
  assert.equal(found?.executable,join(dir,'cursor-agent'));
  assert.equal(found?.version,'Cursor Agent 1.2.3');
});
test('provider registration is identical across services and excludes deferred providers',async()=>{
  const root=new URL('../../../../',import.meta.url);
  const texts=await Promise.all(['apps/local-agent/src/provider-catalog.ts','apps/control-plane/src/provider-catalog.ts','apps/web/src/lib/provider-catalog.ts'].map(p=>readFile(new URL(p,root),'utf8')));
  assert.equal(texts[0],texts[1]);assert.equal(texts[1],texts[2]);
  const catalog=JSON.parse(await readFile(new URL('packages/agent-providers/catalog.json',root),'utf8'));
  const {ACP_COMMANDS}=await import('../src/acp-providers.js');
  assert.deepEqual(catalog.map((p:{id:string})=>p.id),PROVIDER_IDS);
  for(const [id,command] of Object.entries(ACP_COMMANDS)){const row=catalog.find((p:{id:string})=>p.id===id);assert.equal(row.command,command.command);assert.deepEqual(row.args,command.args);}
  assert.deepEqual(PROVIDER_IDS,['codex','claude','qwen','kimi','cursor','codebuddy','grok']);
  assert.equal(isProviderId('copilot'),false);assert.equal(isProviderId('__proto__'),false);
  assert.ok(Object.values(unavailableCapabilities()).every(v=>v===false));
});
test('native identities cannot collide or silently route to Codex',()=>{
  assert.notEqual(encodeProviderThread('qwen','same-id'),encodeProviderThread('kimi','same-id'));
  assert.deepEqual(decodeProviderThread(encodeProviderThread('grok','中文/id')),{provider:'grok',nativeId:'中文/id'});
  assert.equal(threadProvider('claude_123'),'claude');assert.equal(threadProvider('123'),'codex');
  assert.throws(()=>threadProvider('acp_unknown_123'));assert.throws(()=>encodeProviderThread('qwen','x\n'));
});

test('host readiness does not promote an incompatible Codex runtime',async()=>{
 const {evaluateSupport}=await import('../src/platform.js');
 const inputs={platform:'linux' as const,architecture:'x64',uid:1000,nodeVersion:'24.0.0',osRelease:'ID=ubuntu\nVERSION_ID="24.04"',codexVersion:null,codexSchemaHash:null,credentialProtectionLevel:'software_protected' as const};
 const host=evaluateSupport(inputs);assert.equal(host.providerHostSupported,true);assert.equal(host.writable,false);assert.equal(host.readable,false);
 assert.equal(evaluateSupport({...inputs,credentialProtectionLevel:'unknown'}).providerHostSupported,false);
 assert.equal(evaluateSupport({...inputs,nodeVersion:'22.0.0'}).providerHostSupported,false);
});
