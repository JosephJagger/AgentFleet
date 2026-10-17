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
