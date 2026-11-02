import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverCodexAccountReads } from '../src/codex-account-read.js';

const expired = () => new Error('account/rateLimits/read failed: 401 Unauthorized {"code":"token_expired"}');
test('expired quota credentials refresh natively once and return the retried result', async () => {
  const calls: unknown[] = []; let reads = 0;
  const rpc = recoverCodexAccountReads(async (method, params) => {
    calls.push([method, params]);
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(++reads===1)throw expired();
    return {rateLimitResetCredits:{availableCount:2}};
  });
  assert.deepEqual(await rpc('account/rateLimits/read',null),{rateLimitResetCredits:{availableCount:2}});
  assert.deepEqual(calls,[['account/rateLimits/read',null],['account/read',{refreshToken:true}],['account/rateLimits/read',null]]);
});
test('concurrent quota and usage failures share one native credential refresh', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve=>{release=resolve;});
  const reads = new Map<string,number>();let refreshes=0;
  const rpc=recoverCodexAccountReads(async(method)=>{
    if(method==='account/read'){refreshes++;await pending;return {account:{type:'chatgpt'}};}
    const count=reads.get(method)??0;reads.set(method,count+1);if(count===0)throw expired();return {ok:true};
  });
  const first=rpc('account/rateLimits/read',null), second=rpc('account/usage/read',{});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes,1);release();
  assert.deepEqual(await Promise.all([first,second]),[{ok:true},{ok:true}]);
});
test('still-expired retry stops with an actionable auth error', async () => {
  let calls=0;const rpc=recoverCodexAccountReads(async(method)=>{calls++;if(method==='account/read')return {account:{type:'chatgpt'}};throw expired();});
  await assert.rejects(rpc('account/rateLimits/read',null),{code:'CODEX_AUTH_EXPIRED'});assert.equal(calls,3);
});
test('logged-out refresh never retries the account query', async () => {
  let calls=0;const rpc=recoverCodexAccountReads(async(method)=>{calls++;if(method==='account/read')return {account:null};throw expired();});
  await assert.rejects(rpc('account/rateLimits/read',null),{code:'CODEX_AUTH_EXPIRED'});assert.equal(calls,2);
});
test('network failures and non-expiry auth failures do not rotate credentials', async () => {
  for(const error of [new Error('network timeout'),new Error('401 invalid_api_key')]){
    let calls=0;const rpc=recoverCodexAccountReads(async()=>{calls++;throw error;});
    await assert.rejects(rpc('account/rateLimits/read',null),e=>e===error);assert.equal(calls,1);
  }
});
test('mutations including reset-card consumption are never automatically replayed', async () => {
  for(const method of ['account/rateLimitResetCredit/consume','turn/start','account/login/start']){
    let calls=0;const rpc=recoverCodexAccountReads(async()=>{calls++;throw expired();});
    await assert.rejects(rpc(method,{}));assert.equal(calls,1);
  }
});
test('failed native refresh stops the query and allows a later explicit read to refresh again', async () => {
  let refreshes=0;const error=new Error('network timeout');
  const rpc=recoverCodexAccountReads(async method=>{if(method==='account/read'){refreshes++;throw error;}throw expired();});
  await assert.rejects(rpc('account/rateLimits/read',null),e=>e===error);
  await assert.rejects(rpc('account/rateLimits/read',null),e=>e===error);assert.equal(refreshes,2);
});
