import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedChannels,discoverManagedRelease} from '../src/managed-channels.js';
import {parseManagedRelease,parseManagedUpdate,type ManagedRelease} from '../src/managed-provider.js';
const release=(version='1.0.70',id='a'):ManagedRelease=>({provider:'grok',version,id:id.repeat(64),checkedAt:new Date().toISOString(),artifacts:{'linux-x64':{size:123,integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}});
test('checking does not promote; publication and rollback bind exact candidate and revision',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'managed-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}));let current=release();let fail=false;
 const channels=new ManagedChannels(dir,async()=>{if(fail)throw new Error('offline');return current;});
 await channels.check('grok');assert.equal(channels.read('grok').target,undefined);
 assert.throws(()=>channels.control('grok','publish',0,'b'.repeat(64)));
 channels.control('grok','publish',0,current.id);assert.equal(channels.read('grok').target?.version,'1.0.70');
 current=release('1.0.71','b');await channels.check('grok');assert.throws(()=>channels.control('grok','publish',0,current.id));
 channels.control('grok','publish',1,current.id);assert.equal(channels.read('grok').previous?.version,'1.0.70');
 channels.control('grok','rollback',2,'a'.repeat(64));assert.equal(channels.read('grok').target?.version,'1.0.70');
 fail=true;await channels.check('grok');assert.equal(channels.read('grok').phase,'failed');assert.equal(channels.read('grok').target?.version,'1.0.70');
});
test('a concurrent check prevents publication while discovery is changing',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'managed-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));let resolve!:()=>void;
 const channels=new ManagedChannels(dir,async()=>{await new Promise<void>(r=>{resolve=r;});return release();});
 const checking=channels.check('grok');assert.throws(()=>channels.control('grok','publish',0,release().id));resolve();await checking;
 assert.equal(channels.read('grok').phase,'ready');
});
test('release validation rejects unsupported platforms and malformed integrity, status strips private fields',()=>{
 assert.equal(parseManagedRelease(release()).provider,'grok');
 for(const artifacts of [{'../../evil':{size:123,integrity:'x'}},{'linux-x64':{size:1,integrity:'sha512-bad'}}])assert.throws(()=>parseManagedRelease({...release(),artifacts}));
 const at=new Date().toISOString();const result=parseManagedUpdate({revision:1,operationId:'op',provider:'grok',phase:'waiting_idle',targetVersion:'1.0.70',releaseId:'a'.repeat(64),updatedAt:at,path:'/secret',token:'secret'});
 assert(result);assert.equal('path' in result,false);assert.equal('token' in result,false);
});
test('Grok discovery accepts only official, exact-version platform artifacts',async()=>{
 const fetcher=(async(url:unknown)=>new Response(JSON.stringify(String(url).endsWith('/latest')?{name:'@xai-official/grok',version:'1.0.70',optionalDependencies:{'@xai-official/grok-linux-x64':'1.0.70'}}:{name:'@xai-official/grok-linux-x64',version:'1.0.70',dist:{tarball:'https://evil.example/file',integrity:release().artifacts['linux-x64']!.integrity,unpackedSize:123}}))) as typeof fetch;
 await assert.rejects(discoverManagedRelease('grok',fetcher),/artifact/);
});
