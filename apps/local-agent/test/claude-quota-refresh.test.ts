import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import { normalizeClaudeMetadata, type ClaudeMetadata } from "../src/claude-metadata.js";
import type { AppServerCallbacks } from "../src/app-server.js";

test("runtime refresh preserves verified quota, clears changed identity, and never publishes the identity key",async()=>{
 const good={...normalizeClaudeMetadata([],{rate_limits_available:true,rate_limits:{seven_day:{utilization:37}}}),quotaAccountKey:"private-account-key"};
 let metadata:ClaudeMetadata=good;
 let fail=false;
 let binary="/fake/claude";
 const runtime=new ClaudeRuntime({} as AppServerCallbacks,"test",{
   detectClaude:async()=>({installed:true,version:"test",path:binary}),
   inspectClaudeMetadata:async()=>{if(fail)throw new Error("initialization failed");return metadata;},
 });
 await runtime.start();await runtime.refreshMetadata(true);
 assert.equal(runtime.availability.quota?.windows[0]?.remainingPercent,63);
 metadata={...normalizeClaudeMetadata([],null),quotaAccountKey:good.quotaAccountKey,quotaRefreshFailed:true};
 await runtime.refreshMetadata(true);
 assert.equal(runtime.availability.quota?.refreshFailed,true);
 assert.equal(runtime.availability.quota?.observedAt,good.quota.observedAt);
 assert.equal(JSON.stringify(runtime.availability).includes("private-account-key"),false);
 metadata={...metadata,quotaAccountKey:"other-account"};await runtime.refreshMetadata(true);
 assert.deepEqual(runtime.availability.quota?.windows,[]);
 metadata=good;await runtime.refreshMetadata(true);
 assert.equal(runtime.availability.quota?.refreshFailed,undefined);
 fail=true;await runtime.refreshMetadata(true);
 assert.deepEqual(runtime.availability.quota?.windows,[]);
 fail=false;metadata=good;await runtime.refreshMetadata(true);
 binary="/new/claude";
 metadata={...normalizeClaudeMetadata([],null),quotaAccountKey:good.quotaAccountKey,quotaRefreshFailed:true};
 await runtime.start();await runtime.refreshMetadata(true);
 assert.deepEqual(runtime.availability.quota?.windows,[],"binary changes cannot inherit a previous probe cache");
});
