import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {StateStore} from '../src/store.js';
import {ProviderRuntimeManager,reviewedManifest,CLAUDE_SDK_VERSION,claudePlatform,newerVersion,stallGuard} from '../src/provider-runtime-manager.js';
import {AgentError} from '../src/errors.js';
import {Readable,PassThrough} from 'node:stream';
import {parseProviderRuntimeRequest} from '../src/provider-runtime-policy.js';
async function fixture(t:test.TestContext) {
 const dir=await mkdtemp(join(tmpdir(),'provider-runtime-test-'));const store=new StateStore(dir);await store.initialize();t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 let installed=true,auth:'ready'|'login_required'|'unverified'='ready';let revokeOnProbe=false;
 let version='2.1.292',downloads=0,probes=0,activations=0,failProbe=false,failActivate=false,hostVersion='2.1.290 (Claude Code)',clock=Date.now(),stableError:Error|undefined,manifestError:Error|undefined;const latestVersions:Record<string,string>={};const files:string[]=[];const permissionPaths:string[]=[];
 const manager=new ProviderRuntimeManager(store,async()=>{activations++;if(failActivate){failActivate=false;throw new Error('activation failed');}}, {
  authorize:async()=>auth,host:async()=>({installed,version:hostVersion,path:'/host/claude',permissionModes:['default']}),acp:async()=>null,
  permissionModes:async path=>{permissionPaths.push(path);return ['default','auto','acceptEdits','dontAsk'];},
  latest:async(id)=>latestVersions[id]??null,
  stable:async()=>{if(stableError)throw stableError;return version;},
  manifest:async(v,p)=>{if(manifestError)throw manifestError;return {version:v,platform:p,sha256:createHash('sha256').update(v).digest('hex'),size:v.length,sdkVersion:CLAUDE_SDK_VERSION,checkedAt:new Date().toISOString()};},
  download:async(r,file,_signal,onProgress)=>{downloads++;files.push(file);await mkdir(dirname(file),{recursive:true});onProgress?.(r.size);await writeFile(file,r.version);},
  probe:async()=>{probes++;if(revokeOnProbe)auth='login_required';if(failProbe)throw new Error('probe failed');}
 },()=>clock);
 const configure=(mode:'host'|'pinned'|'auto')=>manager.operate({action:'configure',provider:'claude',mode,expectedRevision:manager.state().revision},'op-update');
 return {setInstalled:(v:boolean)=>{installed=v;},setAuth:(v:typeof auth)=>{auth=v;},revokeOnProbe:()=>{revokeOnProbe=true;},store,manager,configure,files,permissionPaths,dir,setVersion:(v:string)=>{version=v;},setHost:(v:string)=>{hostVersion=v;},advance:(ms:number)=>{clock+=ms;},setLatest:(id:string,v:string)=>{latestVersions[id]=v;},setStableError:(e?:Error)=>{stableError=e;},setManifestError:(e?:Error)=>{manifestError=e;},failProbe:()=>{failProbe=true;},failActivate:()=>{failActivate=true;},counts:()=>({downloads,probes,activations})};
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
 const manager=new ProviderRuntimeManager(store,async()=>{activated++;},{authorize:async()=>'ready',host:async()=>({installed:true,version:'2.1.290',path:'/host/claude'}),acp:async()=>null,latest:async()=>null,
  stable:async signal=>new Promise<string>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});entered();}),
  manifest:async()=>{throw new Error('must not fetch');},download:async()=>{throw new Error('must not download');},probe:async()=>{throw new Error('must not probe');}});
 const work=manager.operate({action:'configure',provider:'claude',mode:'auto',expectedRevision:0},'shutdown-test');const rejected=assert.rejects(work);
 await waiting;await manager.stop();await rejected;assert.equal(activated,0);assert.equal(store.snapshot().maintenanceDrain,undefined);assert.equal(manager.state().mode,'host');
 await assert.rejects(manager.operate({action:'check'},'after-stop'));
});

test('enabling managed mode never downgrades a newer host installation',async t=>{
 const f=await fixture(t);f.setHost('2.1.296 (Claude Code)');
 await assert.rejects(f.configure('auto'),/避免降级/);assert.equal(f.manager.state().mode,'host');assert.equal(f.counts().downloads,0);assert.equal(f.counts().activations,0);assert.notEqual(f.manager.state().phase,'blocked');
 f.setHost('2.1.292 (Claude Code)');await f.configure('auto');assert.equal(f.manager.state().mode,'auto');assert.equal(f.manager.state().current?.version,'2.1.292');
});
test('a transient network failure does not block automatic updates and is retried after a delay',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.293');f.advance(7*3600_000);
 f.setStableError(new TypeError('fetch failed'));await assert.rejects(f.manager.automatic());
 assert.notEqual(f.manager.state().phase,'blocked');assert.match(f.manager.state().error??'',/暂时不可用/);
 f.setStableError(undefined);await f.manager.automatic();assert.equal(f.manager.state().current?.version,'2.1.292','still inside the retry delay');
 f.advance(31*60_000);await f.manager.automatic();assert.equal(f.manager.state().current?.version,'2.1.293');assert.equal(f.manager.state().error,'');assert.equal(f.manager.state().phase,'ready');
});
test('a blocked automatic channel heals when the release is fixed, but a bad release is not retried forever',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.293');f.advance(7*3600_000);
 f.setManifestError(new AgentError('PROVIDER_SDK_UNREVIEWED','官方清单尚未确认当前 Claude SDK 组合，保留现有版本'));
 await assert.rejects(f.manager.automatic(),/SDK/);assert.equal(f.manager.state().phase,'blocked');assert.equal(f.manager.state().current?.version,'2.1.292');
 f.advance(3600_000);await f.manager.automatic();assert.equal(f.manager.state().phase,'blocked','not retried inside the blocked delay');
 f.setManifestError(undefined);f.advance(6*3600_000);await f.manager.automatic();assert.equal(f.manager.state().current?.version,'2.1.293');assert.equal(f.manager.state().phase,'ready');
 f.setVersion('2.1.294');f.failProbe();let attempts=0;
 for(let i=0;i<5;i++){f.advance(7*3600_000);const before=f.counts().probes;await f.manager.automatic().catch(()=>undefined);if(f.counts().probes>before)attempts++;}
 assert.equal(attempts,3,'at most three automatic attempts per stable version');assert.equal(f.manager.state().current?.version,'2.1.293');
});
test('only the current and previous managed builds are kept; unrelated entries are untouched',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.293');await f.configure('auto');f.setVersion('2.1.294');await f.configure('auto');
 const root=join(f.dir,'provider-runtimes','claude');const st=f.manager.state();
 const names=(await readdir(root)).sort();assert.deepEqual(names,[`${st.current!.version}-${st.current!.sha256}`,`${st.previous!.version}-${st.previous!.sha256}`].sort());
 await writeFile(join(root,'notes.txt'),'keep');await mkdir(join(root,`2.1.1-${'b'.repeat(64)}`));
 await f.manager.operate({action:'check'},'check');
 const after=await readdir(root);assert.ok(after.includes('notes.txt'));assert.ok(!after.includes(`2.1.1-${'b'.repeat(64)}`));assert.equal(after.length,3);
});

test('discovery records the newest official release of every agent without installing anything',async t=>{
 const f=await fixture(t);f.setLatest('qwen','0.25.2');f.setLatest('grok','1.0.62');f.setVersion('2.1.299');
 await f.manager.refreshLatest(true);const latest=f.manager.state().latest!;
 assert.equal(latest.claude!.version,'2.1.299');assert.equal(latest.qwen!.version,'0.25.2');assert.equal(latest.grok!.version,'1.0.62');assert.equal(latest.kimi,undefined);
 assert.equal(f.counts().downloads,0);assert.equal(f.counts().activations,0);assert.equal(f.manager.state().mode,'host');
 f.setLatest('qwen','0.26.0');f.setStableError(new TypeError('fetch failed'));f.advance(7*3600_000);
 await f.manager.refreshLatest();assert.equal(f.manager.state().latest!.qwen!.version,'0.26.0','one source failing keeps others updating');assert.equal(f.manager.state().latest!.claude!.version,'2.1.299','a failed source keeps its last known value');
 const before=f.manager.state().revision;await f.manager.refreshLatest();assert.equal(f.manager.state().revision,before,'discovery never changes the policy revision');
});
test('update action advances only an already managed build, on explicit request, and keeps the chosen mode',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.manager.operate({action:'update',provider:'claude',expectedRevision:0},'u0'),/宿主机安装/);
 await f.configure('pinned');assert.equal(f.manager.state().current?.version,'2.1.292');
 f.setVersion('2.1.294');await f.configure('pinned');assert.equal(f.manager.state().current?.version,'2.1.292','pinning alone never advances');
 await f.manager.automatic();assert.equal(f.manager.state().current?.version,'2.1.292','a pinned build is never auto-advanced');
 await f.manager.operate({action:'update',provider:'claude',expectedRevision:f.manager.state().revision},'u1');
 assert.equal(f.manager.state().current?.version,'2.1.294');assert.equal(f.manager.state().previous?.version,'2.1.292');assert.equal(f.manager.state().mode,'pinned');
 await assert.rejects(f.manager.operate({action:'update',provider:'claude',expectedRevision:0},'stale'),/设置已变化/);
});
test('Codex confirmation requests are parsed strictly and never reach the Claude manager',async t=>{
 assert.deepEqual(parseProviderRuntimeRequest({action:'confirm',provider:'codex',version:'0.163.0'}),{action:'confirm',provider:'codex',version:'0.163.0'});
 for(const bad of [{action:'confirm',provider:'codex'},{action:'confirm',provider:'codex',version:'0.163'},{action:'confirm',provider:'codex',version:'0.163.0',path:'/x'},{action:'confirm',provider:'claude',version:'0.163.0'},{action:'confirm',provider:'codex',version:'latest'},{action:'update',provider:'codex',expectedRevision:0}])assert.throws(()=>parseProviderRuntimeRequest(bad));
 const f=await fixture(t);await assert.rejects(f.manager.operate({action:'confirm',provider:'codex',version:'0.163.0'},'c'),/更新器/);
});

test('a stalled transfer is cut off after silence, but a slow steady one is never limited by total time',async()=>{
 const stalled=new PassThrough();stalled.write('first');
 const guarded=stallGuard(stalled,60);const seen:string[]=[];
 await assert.rejects((async()=>{for await(const chunk of guarded)seen.push(String(chunk));})(),(error:Error)=>error.name==='TimeoutError');
 assert.deepEqual(seen,['first']);
 const steady=new PassThrough();let total='';
 const writer=(async()=>{for(let i=0;i<12;i++){steady.write('x');await new Promise(r=>setTimeout(r,25));}steady.end();})();
 for await(const chunk of stallGuard(steady,120))total+=String(chunk);await writer;
 assert.equal(total.length,12,'twelve chunks over ~300ms with a 120ms stall limit completes');
 assert.deepEqual([...await (async()=>{const out:string[]=[];for await(const c of stallGuard(Readable.from(['a','b']),50))out.push(String(c));return out;})()],['a','b']);
});
test('a long download publishes its step and progress, and clears them when finished or failed',async t=>{
 const f=await fixture(t);
 const dir=await mkdtemp(join(tmpdir(),'provider-progress-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new StateStore(dir);await store.initialize();t.after(()=>store.close());
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let midway:unknown;let fail=false;
 const manager=new ProviderRuntimeManager(store,async()=>undefined,{
  authorize:async()=>'ready',host:async()=>({installed:true,version:'2.1.290 (Claude Code)',path:'/host/claude'}),acp:async()=>null,latest:async()=>null,stable:async()=>'2.1.292',
  manifest:async(v,p)=>({version:v,platform:p,sha256:createHash('sha256').update(v).digest('hex'),size:v.length,sdkVersion:CLAUDE_SDK_VERSION,checkedAt:new Date().toISOString()}),
  download:async(r,file,_s,onProgress)=>{onProgress?.(3);await new Promise(resolve=>setTimeout(resolve,20));midway=store.snapshot().providerRuntimeState;await gate;if(fail)throw new Error('connection reset');await mkdir(dirname(file),{recursive:true});await writeFile(file,r.version);},
  probe:async()=>undefined});
 const running=manager.operate({action:'configure',provider:'claude',mode:'pinned',expectedRevision:0},'op-progress');
 await new Promise(resolve=>setTimeout(resolve,80));
 const during=store.snapshot().providerRuntimeState!;assert.equal(during.step,'downloading');assert.equal(during.progress?.received,3);assert.equal(during.progress?.total,7);
 assert.ok(midway);release();await running;
 assert.equal(manager.state().step,undefined);assert.equal(manager.state().progress,undefined);assert.equal(manager.state().current?.version,'2.1.292');
 // A failed attempt must not leave a stale progress bar behind either.
 fail=true;await rm(join(dir,'provider-runtimes'),{recursive:true,force:true});
 await manager.operate({action:'configure',provider:'claude',mode:'host',expectedRevision:manager.state().revision},'op-host');
 const again=manager.operate({action:'configure',provider:'claude',mode:'auto',expectedRevision:manager.state().revision},'op-auto');
 await assert.rejects(again);assert.equal(manager.state().step,undefined);assert.equal(manager.state().progress,undefined);
 void f;
});

test('managed Claude reports permissions from its verified binary; host mode uses host metadata',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await f.manager.detectClaude()).permissionModes,['default']);
 assert.deepEqual(f.permissionPaths,[]);
 await f.configure('auto');
 const managed=await f.manager.detectClaude();
 assert.equal(managed.managed,true);
 assert.deepEqual(managed.permissionModes,['default','auto','acceptEdits','dontAsk']);
 assert.equal(f.permissionPaths.at(-1),managed.path);
 await f.configure('pinned');
 assert.deepEqual((await f.manager.detectClaude()).permissionModes,managed.permissionModes);
 const count=f.permissionPaths.length;
 await writeFile(managed.path!,'tampered');
 await assert.rejects(f.manager.detectClaude(),/mismatch/);
 assert.equal(f.permissionPaths.length,count,'never execute an unverified binary to read capabilities');
 await f.configure('host');
 assert.deepEqual((await f.manager.detectClaude()).permissionModes,['default']);
});
test('explicit platform target binds the signed artifact, pins it and rechecks confirmation before switching',async t=>{
 const f=await fixture(t);await f.configure('auto');f.setVersion('2.1.293');
 const release={provider:'claude' as const,version:'2.1.293',id:'a'.repeat(64),checkedAt:new Date().toISOString(),artifacts:{[claudePlatform()]:{integrity:createHash('sha256').update('2.1.293').digest('hex'),size:'2.1.293'.length}}};
 const phases:string[]=[];let current=false;
 const apply=()=>f.manager.operate({action:'configure',provider:'claude',mode:'pinned',expectedRevision:f.manager.state().revision},'platform-target','manual',{release,signal:new AbortController().signal,phase:async p=>{phases.push(p);},assertCurrent:async()=>{if(!current)throw new AgentError('PROVIDER_TARGET_CHANGED','target changed');}});
 await assert.rejects(apply(),/target changed/);assert.equal(f.manager.state().current?.version,'2.1.292');
 current=true;await apply();assert.equal(f.manager.state().current?.version,release.version);assert.equal(f.manager.state().mode,'pinned');assert.ok(phases.includes('activating'));
});

for(const state of ['not_installed','login_required','unverified'] as const)test(`first Claude takeover refuses ${state} before download on legacy and managed paths`,async t=>{
 const f=await fixture(t);if(state==='not_installed')f.setInstalled(false);else f.setAuth(state);
 await assert.rejects(f.configure('pinned'));await assert.rejects(f.configure('auto'));
 assert.equal(f.counts().downloads,0);assert.equal(f.counts().activations,0);assert.equal(f.manager.state().mode,'host');assert.notEqual(f.manager.state().phase,'blocked');
});
test('Claude authorization is checked again before first activation; existing managed upgrades need no native install',async t=>{
 const f=await fixture(t);f.revokeOnProbe();await assert.rejects(f.configure('pinned'),/登录授权/);assert.equal(f.counts().activations,0);assert.equal(f.manager.state().mode,'host');
 const existing=await fixture(t);await existing.configure('auto');existing.setInstalled(false);existing.setAuth('unverified');existing.setVersion('2.1.293');await existing.configure('auto');assert.equal(existing.manager.state().current?.version,'2.1.293');
});
