import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
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
for(const scenario of ['grok-first','unbranded-impostor','failed-help','missing-vendor-help'] as const)test(`Cursor calendar version is verified independently of PATH: ${scenario}`,{skip:process.platform==='win32'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'provider-calendar-'));
  const oldPath=process.env.PATH;
  t.after(async()=>{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});});
  const wrongVersion=scenario==='grok-first'?'grok 1.0.62 [stable]':'2026.10.16-e3cb207';
  const wrongHelp=scenario==='failed-help'?'exit 1':scenario==='missing-vendor-help'?'printf "Usage: agent acp [options]\\n"':'printf "Start the Grok Agent\\n"';
  await writeFile(join(dir,'agent'),`#!/bin/sh
if [ "$1" = "--version" ]; then printf '${wrongVersion}\\n'; else ${wrongHelp}; fi
`,{mode:0o755});
  await writeFile(join(dir,'cursor-agent'),'#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2026.10.16-e3cb207\\n"; elif [ "$1" = "acp" ] && [ "$2" = "--help" ]; then printf "Usage: agent acp [options]\\n\\nStart the Cursor Agent as an ACP (Agent Client Protocol) server\\n"; else exit 1; fi\n',{mode:0o755});
  process.env.PATH=dir;
  const {detectAcp}=await import('../src/acp-providers.js');
  const found=await detectAcp('cursor');
  assert.equal(found?.executable,join(dir,'cursor-agent'));
  assert.equal(found?.version,'2026.10.16-e3cb207');
});
test('Cursor symlink in a later PATH directory is not shadowed by the Grok agent binary',{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'provider-path-'));
  const oldPath=process.env.PATH;
  t.after(async()=>{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});});
  const grok=join(root,'grok-bin'),cursor=join(root,'local-bin'),versions=join(root,'cursor-versions');
  await Promise.all([grok,cursor,versions].map(p=>mkdir(p)));
  await writeFile(join(grok,'agent'),'#!/bin/sh\nprintf "grok 1.0.62 [stable]\\n"\n',{mode:0o755});
  const target=join(versions,'cursor-agent');
  await writeFile(target,'#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2026.10.16-e3cb207\\n"; elif [ "$1" = "acp" ] && [ "$2" = "--help" ]; then printf "Start the Cursor Agent as an ACP (Agent Client Protocol) server\\n"; else exit 1; fi\n',{mode:0o755});
  await symlink(target,join(cursor,'agent'));await symlink(target,join(cursor,'cursor-agent'));
  process.env.PATH=[grok,cursor].join(delimiter);
  const {detectAcp}=await import('../src/acp-providers.js');
  const found=await detectAcp('cursor');
  assert.equal(found?.executable,join(cursor,'agent'));assert.equal(found?.version,'2026.10.16-e3cb207');
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
