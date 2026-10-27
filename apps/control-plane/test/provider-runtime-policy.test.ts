import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProviderRuntimeRequest,parseProviderRuntimeState} from '../src/provider-runtime-policy.js';
test('relayed requests allow only the fixed confirmation and update shapes',()=>{
 assert.deepEqual(parseProviderRuntimeRequest({action:'confirm',provider:'codex',version:'0.163.0'}),{action:'confirm',provider:'codex',version:'0.163.0'});
 assert.deepEqual(parseProviderRuntimeRequest({action:'update',provider:'claude',expectedRevision:3}),{action:'update',provider:'claude',expectedRevision:3});
 for(const bad of [{action:'confirm',provider:'codex',version:'0.163.0-alpha'},{action:'confirm',provider:'codex',version:'0.163.0',url:'https://x'},{action:'confirm',provider:'grok',version:'1.0.0'},{action:'update',provider:'claude'},{action:'update',provider:'claude',expectedRevision:-1},{action:'update',provider:'claude',expectedRevision:1,mode:'auto'},{action:'install',provider:'qwen',version:'1.0.0'}])
  assert.throws(()=>parseProviderRuntimeRequest(bad),Error);
});
test('discovered versions are bounded, typed and limited to known agents',()=>{
 const at='2026-10-17T00:00:00Z';
 const state=parseProviderRuntimeState({revision:1,mode:'host',latest:{qwen:{version:'0.25.2',checkedAt:at},claude:{version:'2.1.300',checkedAt:at},evil:{version:'1.0.0',checkedAt:at},grok:{version:'1.0.0; rm -rf /',checkedAt:at},kimi:{version:'2.2.0',checkedAt:'not a date'},codebuddy:'2.0.0'}});
 assert.deepEqual(state?.latest,{qwen:{version:'0.25.2',checkedAt:at},claude:{version:'2.1.300',checkedAt:at}});
 assert.equal(parseProviderRuntimeState({revision:1,mode:'host',latest:[]})?.latest,undefined);
});

test('managed commands bind provider, release digest and revision and cannot supply installation paths',()=>{
 const request={action:'install-managed',provider:'grok',releaseId:'a'.repeat(64),expectedRevision:0};
 assert.deepEqual(parseProviderRuntimeRequest(request),request);
 for(const bad of [{...request,provider:'qwen'},{...request,expectedRevision:-1},{...request,releaseId:'latest'},{...request,url:'https://example.com'},{action:'rollback-managed',provider:'claude',expectedRevision:0}])assert.throws(()=>parseProviderRuntimeRequest(bad));
});

test('first managed admission rejects missing, stale or failed proof on both routes; retained runtimes remain usable',async()=>{
 const {requireFirstManagedAdmission}=await import('../src/maintenance.js');
 const checkedAt=new Date().toISOString();
 const requests=[{action:'configure',provider:'claude',mode:'auto',expectedRevision:0},{action:'install-managed',provider:'claude',releaseId:'a'.repeat(64),expectedRevision:0},{action:'install-managed',provider:'grok',releaseId:'a'.repeat(64),expectedRevision:0}].map(parseProviderRuntimeRequest);
 for(const request of requests){
  assert.throws(()=>requireFirstManagedAdmission({},request));
  for(const state of ['not_installed','login_required','unverified','managed'])assert.throws(()=>requireFirstManagedAdmission({managedEligibilitySupport:true,managedEligibility:{claude:{state,checkedAt},grok:{state,checkedAt}}},request));
  assert.throws(()=>requireFirstManagedAdmission({managedEligibilitySupport:true,managedEligibility:{claude:{state:'ready',checkedAt:'2020-01-01T00:00:00Z'},grok:{state:'ready',checkedAt:'2020-01-01T00:00:00Z'}}},request));
  assert.doesNotThrow(()=>requireFirstManagedAdmission({managedEligibilitySupport:true,managedEligibility:{claude:{state:'ready',checkedAt},grok:{state:'ready',checkedAt}}},request));
 }
 assert.doesNotThrow(()=>requireFirstManagedAdmission({managedGrokVersion:'1.0.70'},requests[2]!));
 assert.doesNotThrow(()=>requireFirstManagedAdmission({providerRuntimePolicy:{revision:1,mode:'pinned',current:{version:'2.1.308',sha256:'a'.repeat(64),size:10,platform:'linux-x64',checkedAt,sdkVersion:'0.3.285'}}},requests[1]!));
});
