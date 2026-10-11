import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentReleaseStatus} from '../src/agent-release-status.js';
const manifest=(version:string)=>({schemaVersion:1,version,artifacts:{'linux-x64':{}}});
test('public release mismatch cannot be reported as current; requests are coalesced',async()=>{
 let calls=0;
 const check=createAgentReleaseStatus(async()=>({agentManifestVersion:'1.2.4'}),'https://example.test', (async()=>{calls++;return new Response(JSON.stringify(manifest('1.2.3')));}) as typeof fetch);
 const [a,b]=await Promise.all([check(),check()]);assert.equal(a.status,'mismatch');assert.equal(a.publicVersion,'1.2.3');assert.deepEqual(a,b);assert.equal(calls,1);
});
test('matching and unavailable public routes remain distinct',async()=>{
 for(const [body,status] of [[JSON.stringify(manifest('1.2.4')),'ready'],['<html>','unavailable']] as const){
 const check=createAgentReleaseStatus(async()=>({agentManifestVersion:'1.2.4'}),'https://example.test',(async()=>new Response(body)) as typeof fetch);assert.equal((await check()).status,status);
 }
});
