import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {StateStore} from '../src/store.js';
import {ProviderRuntimeManager,reviewedManifest,CLAUDE_SDK_VERSION,claudePlatform,newerVersion} from '../src/provider-runtime-manager.js';
import {parseProviderRuntimeRequest} from '../src/provider-runtime-policy.js';
async function fixture(t:test.TestContext) {
 const dir=await mkdtemp(join(tmpdir(),'provider-runtime-test-'));const store=new StateStore(dir);await store.initialize();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 let version='2.1.292',downloads=0,probes=0,activations=0,failProbe=false,failActivate=false;const files:string[]=[];
 const manager=new ProviderRuntimeManager(store,async()=>{activations++;if(failActivate){failActivate=false;throw new Error('activation failed');}}, {
  host:async()=>({installed:true,version:'2.1.290 (Claude Code)',path:'/host/claude'}),acp:async()=>null,
  stable:async()=>version,
  manifest:async(v,p)=>({version:v,platform:p,sha256:createHash('sha256').update(v).digest('hex'),size:v.length,sdkVersion:CLAUDE_SDK_VERSION,checkedAt:new Date().toISOString()}),
  download:async(r,file)=>{downloads++;files.push(file);await mkdir(dirname(file),{recursive:true});await writeFile(file,r.version);},
  probe:async()=>{probes++;if(failProbe)throw new Error('probe failed');}
 });
 const configure=(mode:'host'|'pinned'|'auto')=>manager.operate({action:'configure',provider:'claude',mode,expectedRevision:manager.state().revision},'op-update');
 return {store,manager,configure,files,setVersion:(v:string)=>{version=v;},failProbe:()=>{failProbe=true;},failActivate:()=>{failActivate=true;},counts:()=>({downloads,probes,activations})};
}
test('request allowlist excludes shell paths, other providers, versions, unknown keys and missing conflict guard',()=>{
 for(const v of [{action:'check',url:'https://evil'}, {action:'configure',provider:'codex',mode:'auto',expectedRevision:0},{action:'configure',provider:'claude',mode:'auto'}, {action:'configure',provider:'claude',mode:'auto',expectedRevision:0,path:'/tmp/x'}])assert.throws(()=>parseProviderRuntimeRequest(v));
 assert.deepEqual(parseProviderRuntimeRequest({action:'check'}),{action:'check'});
});
test('official manifest must bind exact CLI, SDK, platform, size and digest; SDK pin stays in sync',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'],CLAUDE_SDK_VERSION);
 const platform=claudePlatform();const good={version:'2.1.292',sdkCompat:{harnessSchema:1,testedWrapperVersions:[CLAUDE_SDK_VERSION]},platforms:{[platform]:{binary:process.platform==='win32'?'claude.exe':'claude',size:20,checksum:'a'.repeat(64)}}};
 assert.equal(reviewedManifest(good,'2.1.292',platform).sdkVersion,CLAUDE_SDK_VERSION);
 for(const bad of [{...good,version:'2.1.293'},{...good,sdkCompat:{}},{...good,platforms:{}},null])assert.throws(()=>reviewedManifest(bad,'2.1.292',platform));
 assert.equal(newerVersion('2.1.100','2.1.99'),true);assert.equal(newerVersion('2.1.99','2.1.100'),false);
});
test('default/check never install or switch host runtime; inventory does not mistake negotiation for full validation',async t=>{
 const f=await fixture(t);assert.equal((await f.manager.detectClaude()).path,'/host/claude');await f.manager.operate({action:'check'},'check');
 assert.equal(f.counts().downloads,0);assert.equal(f.counts().activations,0);assert.equal(f.manager.state().mode,'host');
 const report=await f.manager.inventory({},{});const rows=report.providers as Record<string,{compatibility:string}>;assert.equal(rows.claude!.compatibility,'protocol_checked');assert.equal(rows.qwen!.compatibility,'unverified');
});
test('active voice blocks activation; staged binary reused after idle; source policy persists',async t=>{
 const f=await fixture(t);await f.store.setPanelVoiceRuntime({voiceId:'live-call'});
 await assert.rejects(f.configure('auto'),/任务或通话/);assert.equal(f.manager.state().mode,'host');assert.equal(f.counts().activations,0);assert.equal(f.store.snapshot().maintenanceDrain,undefined);
 await f.store.setPanelVoiceRuntime(undefined);await f.configure('auto');assert.equal(f.counts().downloads,1);assert.equal(f.manager.state().mode,'auto');assert.notEqual((await f.manager.detectClaude()).path,'/host/claude');assert.equal(f.store.snapshot().maintenanceDrain,undefined);
});
test('probe and activation failures preserve previous selection; rollback pins and stops automatic promotion',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.293');await f.configure('auto');
 assert.equal(f.manager.state().previous?.version,'2.1.292');await f.manager.operate({action:'rollback',provider:'claude',expectedRevision:f.manager.state().revision},'rollback');assert.equal(f.manager.state().current?.version,'2.1.292');assert.equal(f.manager.state().mode,'pinned');
 const count=f.counts().downloads;await f.manager.automatic();assert.equal(f.counts().downloads,count);
 f.setVersion('2.1.294');f.failActivate();await assert.rejects(f.configure('auto'));assert.equal(f.manager.state().current?.version,'2.1.292');assert.equal(f.manager.state().mode,'pinned');assert.equal(f.store.snapshot().maintenanceDrain,undefined);
 f.setVersion('2.1.295');f.failProbe();await assert.rejects(f.configure('auto'));assert.equal(f.manager.state().current?.version,'2.1.292');
});
test('stale save is rejected; pin freezes current without downloads, damaged managed binary cannot fall back silently',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.300');await f.configure('pinned');assert.equal(f.manager.state().current?.version,'2.1.292');assert.equal(f.counts().downloads,1);
 await assert.rejects(f.manager.operate({action:'configure',provider:'claude',mode:'host',expectedRevision:0},'old'),/设置已变化/);
 await writeFile(f.files[0]!,'damaged');await assert.rejects(f.manager.detectClaude());assert.equal(f.manager.state().mode,'pinned');
 await f.configure('host');assert.equal((await f.manager.detectClaude()).path,'/host/claude');
});
test('unknown work, reservations and auxiliary activities block switching and leave tasks unchanged',async t=>{
 const f=await fixture(t);f.store.setAuxiliaryActivity('native-voice',true);await assert.rejects(f.configure('auto'),/任务或通话/);f.store.setAuxiliaryActivity('native-voice',false);
 await f.store.update(s=>{s.projectReservations.project={commandId:'pending'} as never;});await assert.rejects(f.configure('auto'),/任务或通话/);assert.equal(f.store.snapshot().projectReservations.project?.commandId,'pending');assert.equal(f.counts().activations,0);
});

test('unchanged stable channel does not restart Claude, and persisted policy survives a store reopen',async t=>{
 const f=await fixture(t);await f.configure('auto');const before=f.counts();await f.configure('auto');assert.equal(f.counts().activations,before.activations);assert.equal(f.counts().downloads,before.downloads);
 const dir=f.store.dataDir;f.store.close();const restored=new StateStore(dir);await restored.initialize();assert.equal(restored.snapshot().providerRuntimeState?.mode,'auto');assert.equal(restored.snapshot().providerRuntimeState?.current?.version,'2.1.292');restored.close();
});

test('shutdown aborts a pending release check and never activates or leaves admission fenced',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'provider-shutdown-'));const store=new StateStore(dir);await store.initialize();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});let activated=0;
 const manager=new ProviderRuntimeManager(store,async()=>{activated++;},{host:async()=>({installed:false,version:null}),acp:async()=>null,
  stable:async signal=>new Promise<string>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});entered();}),
  manifest:async()=>{throw new Error('must not fetch');},download:async()=>{throw new Error('must not download');},probe:async()=>{throw new Error('must not probe');}});
 const work=manager.operate({action:'configure',provider:'claude',mode:'auto',expectedRevision:0},'shutdown-test');const rejected=assert.rejects(work);
 await waiting;await manager.stop();await rejected;assert.equal(activated,0);assert.equal(store.snapshot().maintenanceDrain,undefined);assert.equal(manager.state().mode,'host');
 await assert.rejects(manager.operate({action:'check'},'after-stop'));
});
