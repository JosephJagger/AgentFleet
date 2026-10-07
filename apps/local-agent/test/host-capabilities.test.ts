import test from "node:test";
import assert from "node:assert/strict";
import { executeCodexOperation } from "../src/codex-operation-executor.js";
import { parseHostCodexOperation } from "../src/codex-operations.js";

test("experimental writes use current catalog and version, not arbitrary config paths", async () => {
  const writes: unknown[] = [];
  const rpc = async (method: string, params: Record<string, unknown> | null) => {
    if (method === "config/read") return {layers:[{name:{type:"user"},version:"v2"}]};
    if (method === "experimentalFeature/list") return {data:[{name:"beta_feature",stage:"beta",enabled:false},{name:"unfinished",stage:"underDevelopment",enabled:false}]};
    writes.push(params);return {status:"ok"};
  };
  const run=(name:string,version="v2")=>executeCodexOperation(parseHostCodexOperation({operation:"experiments.save",arguments:{name,version,enabled:true,confirmed:true}}),"","m",rpc,async()=>{});
  await assert.rejects(run("beta_feature","v1"),/变化/);await assert.rejects(run("unfinished"),/尚未开放/);await assert.rejects(run("invented"),/尚未开放/);assert.equal(writes.length,0);
  assert.equal((await run("beta_feature")).status,"savedRequiresReconnect");assert.deepEqual(writes,[{keyPath:"features.beta_feature",value:true,mergeStrategy:"replace",expectedVersion:"v2"}]);
});
test("import re-detects selected native items and refuses stale or forged selections", async()=>{
  let changed=false; const imports:unknown[]=[];
  const rpc=async(method:string,params:Record<string,unknown>|null)=>{
    if(method==="externalAgentConfig/detect")return {items:[{itemType:"SKILLS",description:changed?"new":"one",details:{skills:[{name:"first"}]}}]};
    imports.push(params);return {importId:"import-1"};
  };
  const run=(operation:string,args:Record<string,unknown>={})=>executeCodexOperation(parseHostCodexOperation({operation,arguments:args}),"","m",rpc,async()=>{});
  const preview=await run("migration.detect");const id=preview.rows[0]!.name;
  changed=true;await assert.rejects(run("migration.import",{itemIds:[id],confirmed:true}),/变化/);assert.equal(imports.length,0);
  changed=false;assert.equal((await run("migration.import",{itemIds:[id],confirmed:true})).status,"started");assert.equal(imports.length,1);
  assert.throws(()=>parseHostCodexOperation({operation:"migration.import",arguments:{itemIds:[id],confirmed:true,migrationItems:[{cwd:"/etc"}]}}));
});
test("Bedrock setup selects existing host profiles and never accepts credential fields",async()=>{
 const calls:unknown[]=[];const rpc=async(method:string,params:Record<string,unknown>|null)=>{if(method==="account/bedrock/discover")return {profiles:[{name:"work",region:"us-east-1"}],environmentCredentials:[{type:"accessKeys"}]};calls.push(params);return {};};
 const run=(profile:string)=>executeCodexOperation({operation:"bedrock.setup",arguments:{profile,region:"us-east-1",confirmed:true}},"","m",rpc,async()=>{});
 await assert.rejects(run("missing"),/不存在/);assert.equal(calls.length,0);await run("work");assert.deepEqual(calls,[{type:"profile",profile:"work",region:"us-east-1"}]);
 assert.throws(()=>parseHostCodexOperation({operation:"bedrock.setup",arguments:{profile:"work",region:"us-east-1",confirmed:true,apiKey:"secret"}}));
});
test("subagent history is bound to the native parent and project",async()=>{
 let parent="other";let cwd="/project";let reads=0;
 const rpc=async(method:string)=>{if(method==="thread/read")return {thread:{parentThreadId:parent,cwd}};reads++;return {data:[{status:"completed",items:[{type:"agentMessage",text:"done"}]}]};};
 const run=()=>executeCodexOperation({operation:"subagents.history",arguments:{threadId:"child"}},"parent","m",rpc,async()=>{},undefined,"/project");
 await assert.rejects(run(),/不属于/);parent="parent";cwd="/other";await assert.rejects(run(),/不属于/);assert.equal(reads,0);cwd="/project";assert.equal((await run()).rows[0]!.detail,"done");
});
