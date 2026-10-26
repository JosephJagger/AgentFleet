import test from 'node:test';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StateStore} from '../src/store.js';
import {ProviderRuntimeManager} from '../src/provider-runtime-manager.js';
import {ManagedProviderUpdates} from '../src/managed-provider-updates.js';
import type {ManagedRelease,ManagedPhase} from '../src/managed-provider.js';
import {grokBinary} from '../src/managed-grok.js';
const release:ManagedRelease={provider:'grok',version:'1.0.70',id:'a'.repeat(64),checkedAt:new Date().toISOString(),artifacts:{'linux-x64':{size:100,integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}};
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'managed-jobs-')),store=new StateStore(dir);await store.initialize();let installs=0,activations=0,fail=false;let target=release;
 const manager=new ManagedProviderUpdates(store,new ProviderRuntimeManager(store,async()=>{}),async()=>target,async()=>{activations++;if(fail)throw new Error('activation failed');},()=>{},{
  prepareGrok:async(_root,r)=>{installs++;return {release:r,sha256:'b'.repeat(64)};},verifyGrok:async()=>'/managed/grok',probeGrok:async()=>{},detectAcp:async()=>null,
 });
 t.after(async()=>{await manager.stop();store.close();await rm(dir,{recursive:true,force:true});});
 const wait=async(phase:ManagedPhase)=>{for(let i=0;i<100;i++){if(store.snapshot().managedUpdates?.grok?.phase===phase)return;await new Promise(r=>setTimeout(r,10));}assert.equal(store.snapshot().managedUpdates?.grok?.phase,phase);};
 const install=()=>manager.request({action:'install-managed',provider:'grok',releaseId:target.id,expectedRevision:store.snapshot().managedUpdates?.grok?.revision??0},'op');
 return {store,manager,wait,install,counts:()=>({installs,activations}),change:()=>{target={...release,version:'1.0.71',id:'c'.repeat(64)};},fail:()=>{fail=true;}};
}
test('manual update reports success only after activation; stale confirmation does not install',async t=>{
 const f=await fixture(t);await assert.rejects(f.manager.request({action:'install-managed',provider:'grok',releaseId:'e'.repeat(64),expectedRevision:0},'op'));
 assert.equal(f.counts().installs,0);await f.install();await f.wait('succeeded');assert.equal(f.store.snapshot().managedGrok?.current.release.version,'1.0.70');assert.equal(f.counts().activations,1);
 assert.equal((await f.manager.detectGrok())?.executable,'/managed/grok');
});
test('busy host retains prepared update, cancel cannot be mistaken for a completed upgrade',async t=>{
 const f=await fixture(t);await f.store.setPanelVoiceRuntime({voiceId:'voice'});await f.install();await f.wait('waiting_idle');
 assert.equal(f.counts().activations,0);assert.equal(f.store.snapshot().managedGrok,undefined);
 await f.manager.request({action:'cancel-managed',provider:'grok',expectedRevision:1},'cancel');await f.wait('cancelled');assert.equal(f.store.snapshot().maintenanceDrain,undefined);
});
test('activation failure restores the last working binary and interrupted work becomes unknown',async t=>{
 const f=await fixture(t);await f.install();await f.wait('succeeded');f.change();f.fail();await f.install();await f.wait('failed');assert.equal(f.store.snapshot().managedGrok?.current.release.version,'1.0.70');assert.equal(f.store.snapshot().maintenanceDrain,undefined);
 await f.store.update(s=>{s.managedUpdates!.grok!.phase='activating';});await f.manager.start();assert.equal(f.store.snapshot().managedUpdates?.grok?.phase,'unknown');
});
test('package integrity is checked before attempting to execute or unpack content',()=>{
 assert.throws(()=>grokBinary(Buffer.from('not an archive'),'sha512-'+Buffer.alloc(64).toString('base64'),100),/校验失败/);
});
test('idle resumption uses the staged release and target changes invalidate the old confirmation',async t=>{
 const f=await fixture(t);await f.store.setPanelVoiceRuntime({voiceId:'voice'});await f.install();await f.wait('waiting_idle');
 await f.store.setPanelVoiceRuntime(undefined);await f.manager.start();await f.wait('succeeded');
 assert.equal(f.counts().installs,1);assert.equal(f.counts().activations,1);
 const changed=await fixture(t);await changed.store.setPanelVoiceRuntime({voiceId:'voice'});await changed.install();await changed.wait('waiting_idle');changed.change();
 await changed.store.setPanelVoiceRuntime(undefined);await changed.manager.start();await changed.wait('failed');assert.equal(changed.counts().activations,0);assert.match(changed.store.snapshot().managedUpdates?.grok?.error??'',/目标已变化/);
});
test('explicit rollback restores the retained version without depending on the current published target',async t=>{
 const f=await fixture(t);await f.install();await f.wait('succeeded');f.change();await f.install();await f.wait('succeeded');
 await f.manager.request({action:'rollback-managed',provider:'grok',expectedRevision:2},'rollback');await f.wait('succeeded');
 assert.equal(f.store.snapshot().managedGrok?.current.release.version,'1.0.70');assert.equal(f.store.snapshot().managedGrok?.previous?.release.version,'1.0.71');assert.equal(f.counts().installs,2);
});

test('package extraction handles the official Brotli wrapper and refuses links or duplicate binaries',()=>{
 const payload=Buffer.from('verified executable'),compressed=brotliCompressSync(payload);
 const entry=(type='0')=>{const header=Buffer.alloc(512);header.write('package/bin/grok.br');header.write(compressed.length.toString(8).padStart(11,'0')+'\0',124);header[156]=type.charCodeAt(0);header.fill(32,148,156);const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([header,compressed,Buffer.alloc(512-compressed.length%512)]);};
 const extract=(tar:Buffer)=>{const archive=gzipSync(tar);return grokBinary(archive,'sha512-'+createHash('sha512').update(archive).digest('base64'),4096);};
 assert.deepEqual(extract(entry()),payload);assert.throws(()=>extract(entry('2')),/Invalid package binary/);assert.throws(()=>extract(Buffer.concat([entry(),entry()])),/Invalid package binary/);
});
