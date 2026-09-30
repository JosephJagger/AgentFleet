import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeClaudeMetadata } from "../src/claude-metadata.js";
test("native quota percentages, resets and versioned models are normalized without credentials",()=>{
 const result=normalizeClaudeMetadata([{value:"default",resolvedModel:"claude-opus-5-5",displayName:"Default"},{value:"opus",resolvedModel:"claude-opus-5-5",displayName:"Opus 5.5",supportedEffortLevels:["high","max","bogus"]}],{subscription_type:"pro",rate_limits_available:true,accessToken:"secret",rate_limits:{five_hour:{utilization:5,resets_at:"2026-10-01T10:00:00Z"},seven_day:{utilization:1,resets_at:null},seven_day_opus:{utilization:null,resets_at:null},model_scoped:[{display_name:"Fable",utilization:0,resets_at:null}]}});
 assert.deepEqual(result.models,[{model:"claude-opus-5-5",displayName:"Opus 5.5",efforts:["high","max"]}]);
 assert.equal(result.quota.subscriptionType,"pro");assert.equal(result.quota.windows[0]?.remainingPercent,95);assert.equal(result.quota.windows[0]?.resetsAt,Date.parse("2026-10-01T10:00:00Z")/1000);assert.equal(result.quota.windows.length,3);assert.equal(JSON.stringify(result).includes("secret"),false);
});
test("API-key and malformed native limits never become subscription quota",()=>{
 assert.deepEqual(normalizeClaudeMetadata([],{rate_limits_available:false,rate_limits:{five_hour:{utilization:50}}}).quota.windows,[]);
 assert.deepEqual(normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{five_hour:{utilization:-1},seven_day:{utilization:Infinity}}}).quota.windows,[]);
});
