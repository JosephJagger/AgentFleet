import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaudeMetadata, claudeQuotaAccountKey, retainedClaudeQuota, collectClaudeMetadata } from "../src/claude-metadata.js";
test("native quota percentages, resets and versioned models are normalized without credentials",()=>{
 const result=normalizeClaudeMetadata([{value:"default",resolvedModel:"claude-opus-5-5",displayName:"Default"},{value:"opus",resolvedModel:"claude-opus-5-5",displayName:"Opus 5.5",supportedEffortLevels:["high","max","bogus"]}],{subscription_type:"pro",rate_limits_available:true,accessToken:"secret",rate_limits:{five_hour:{utilization:5,resets_at:"2026-10-01T10:00:00Z"},seven_day:{utilization:1,resets_at:null},seven_day_opus:{utilization:null,resets_at:null},model_scoped:[{display_name:"Fable",utilization:0,resets_at:null}]}});
 assert.deepEqual(result.models,[{model:"claude-opus-5-5",displayName:"Opus 5.5",efforts:["high","max"]}]);
 assert.equal(result.quota.subscriptionType,"pro");assert.equal(result.quota.windows[0]?.remainingPercent,95);assert.equal(result.quota.windows[0]?.resetsAt,Date.parse("2026-10-01T10:00:00Z")/1000);assert.equal(result.quota.windows.length,3);assert.equal(JSON.stringify(result).includes("secret"),false);
});
test("API-key and malformed native limits never become subscription quota",()=>{
 assert.deepEqual(normalizeClaudeMetadata([],{rate_limits_available:false,rate_limits:{five_hour:{utilization:50}}}).quota.windows,[]);
 assert.deepEqual(normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{five_hour:{utilization:-1},seven_day:{utilization:Infinity}}}).quota.windows,[]);
});

test("only verified native account identity can key a retained quota snapshot",()=>{
 const account={email:"one@example.test",organization:"org",subscriptionType:"pro",tokenSource:"oauth",apiProvider:"firstParty" as const};
 const key=claudeQuotaAccountKey(account);
 assert.match(key!,/^[a-f0-9]{64}$/);
 assert.equal(claudeQuotaAccountKey({...account,apiKeySource:"none"}),key);
 assert.notEqual(claudeQuotaAccountKey({...account,email:"two@example.test"}),key);
 assert.notEqual(claudeQuotaAccountKey({...account,organization:"other"}),key);
 assert.equal(claudeQuotaAccountKey({}),undefined);
 assert.equal(claudeQuotaAccountKey({email:account.email}),undefined);
 assert.equal(claudeQuotaAccountKey({...account,apiProvider:"bedrock"}),undefined);
 assert.equal(claudeQuotaAccountKey({...account,apiKeySource:"environment"}),undefined);
});

test("temporary failure retains the same account snapshot and original time, recovery replaces it",()=>{
 const previous=normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{seven_day:{utilization:37}}}).quota;
 const failed={...normalizeClaudeMetadata([],null),quotaAccountKey:"one",quotaRefreshFailed:true};
 const retained=retainedClaudeQuota(previous,"one",failed);
 assert.deepEqual(retained,{...previous,refreshFailed:true});
 assert.equal(retained.observedAt,previous.observedAt);
 assert.equal(previous.refreshFailed,undefined);
 const recovered={...normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{seven_day:{utilization:42}}}),quotaAccountKey:"one"};
 assert.equal(retainedClaudeQuota(retained,"one",recovered),recovered.quota);
 assert.equal(recovered.quota.refreshFailed,undefined);
});

test("logout, unsupported auth, missing identity, account changes and first-read errors never reuse quota",()=>{
 const previous=normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{seven_day:{utilization:37}}}).quota;
 const unavailable=normalizeClaudeMetadata([],{rate_limits_available:false});
 for(const next of [
   {...unavailable,quotaAccountKey:"one",quotaRefreshFailed:false},
   {...unavailable,quotaAccountKey:"two",quotaRefreshFailed:true},
   {...unavailable,quotaRefreshFailed:true},
 ])assert.equal(retainedClaudeQuota(previous,"one",next),next.quota);
 const failed={...unavailable,quotaAccountKey:"one",quotaRefreshFailed:true};
 assert.equal(retainedClaudeQuota(undefined,"one",failed),failed.quota);
 assert.equal(retainedClaudeQuota(previous,undefined,failed),failed.quota);
});

test("a timed-out usage control request preserves a separately verified account and models",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]});
 const result=collectClaudeMetadata({
   supportedModels:async()=>[{value:"sonnet",resolvedModel:"claude-sonnet-5-5",displayName:"Sonnet",description:"test"}],
   accountInfo:async()=>({email:"one@example.test",organization:"org"}),
   usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:()=>new Promise(()=>{}),
 });
 for(let i=0;i<10;i++)await Promise.resolve();
 t.mock.timers.tick(15_000);
 const metadata=await result;
 assert.equal(metadata.quotaRefreshFailed,true);
 assert.ok(metadata.quotaAccountKey);
 assert.equal(metadata.models[0]?.model,"claude-sonnet-5-5");
 assert.equal(metadata.quota.available,false);
});
