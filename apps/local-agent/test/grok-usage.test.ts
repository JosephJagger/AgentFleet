import test from 'node:test';
import assert from 'node:assert/strict';
import {grokPersistedUsage} from '../src/grok-usage.js';
import {grokBillingQuota,parseGrokQuota} from '../src/grok-quota.js';
import {acpToolItem} from '../src/acp-updates.js';
const counts=(n:number)=>({inputTokens:n*10,outputTokens:n*2,cachedReadTokens:n*3,reasoningTokens:n,totalTokens:n*12});
const file=(n=20,last=1)=>({sessionId:'synthetic',session:counts(n),turns:[{endedAt:new Date().toISOString(),...counts(last)}]});
test('Grok uses persisted cumulative ledger and the latest full turn, including cache and reasoning',()=>{
 const first=grokPersistedUsage(file(20,3),'synthetic',Date.now()-1000)!;
 const resumed=grokPersistedUsage(file(21,1),'synthetic',Date.now()-1000)!;
 assert.equal(first.usage.last.totalTokens,36);assert.equal(resumed.usage.total.totalTokens,252);
 assert.equal(resumed.usage.last.totalTokens,12);assert.equal(first.usage.total.cachedInputTokens,60);
 assert.equal(first.usage.total.inputTokens,200);assert.equal(first.usage.last.reasoningOutputTokens,3);
});
test('foreign, stale, partial or corrupt usage is unknown, never a reused previous turn',()=>{
 const f=file();const start=Date.now()-1000;
 assert.equal(grokPersistedUsage(f,'other',start),undefined);
 assert.equal(grokPersistedUsage({...f,turns:[{...f.turns[0],endedAt:'2000-01-01'}]},'synthetic',start),undefined);
 assert.equal(grokPersistedUsage({...f,session:{...f.session,usageIsIncomplete:true}},'synthetic',start),undefined);
 for(const value of [-1,undefined,NaN,'20'])assert.equal(grokPersistedUsage({...f,session:{...f.session,cachedReadTokens:value}},'synthetic',start),undefined);
 assert.equal(grokPersistedUsage(file(1,2),'synthetic',start),undefined);
 assert.equal(grokPersistedUsage({...f,session:{...f.session,cachedReadTokens:99999}},'synthetic',start),undefined);
});
test('quota uses native actual periods, is sanitized and keeps unknown separate from zero',()=>{
 const start=Date.now()-86400000,end=start+7*86400000;
 const config={creditUsagePercent:4,currentPeriod:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},accessToken:'secret'};
 const quota=grokBillingQuota({config})!;
 assert.equal(quota.windows[0]?.remainingPercent,96);assert.equal(quota.windows[0]?.windowMinutes,10080);
 assert.deepEqual(parseGrokQuota({...quota,secret:'secret'}),quota);
 assert.equal(JSON.stringify(quota).includes('secret'),false);
 assert.equal(grokBillingQuota({config:{...config,creditUsagePercent:0}})?.windows[0]?.remainingPercent,100);
 for(const value of [undefined,-1,101,NaN,'4'])assert.equal(grokBillingQuota({config:{...config,creditUsagePercent:value}}),undefined);
 assert.equal(parseGrokQuota({...quota,observedAt:'invalid'}),undefined);
});
test('native readable code output wins when raw output is a nested enum',()=>{
 const output='const x = 1;\n'.repeat(400);
 const item=acpToolItem({status:'completed',rawOutput:{type:'ReadFile',FileContent:{content:output}},content:[{type:'content',content:{type:'text',text:output}}]});
 assert.equal(item.aggregatedOutput,output);
});
