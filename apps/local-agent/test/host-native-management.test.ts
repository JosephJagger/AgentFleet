import test from "node:test";
import assert from "node:assert/strict";
import { parseHostCodexOperation } from "../src/codex-operations.js";
import { CodexAppServer } from "../src/app-server.js";
import { AgentRuntime } from "../src/runtime.js";

test("host operations reject session scope and unconfirmed mutations", () => {
  assert.throws(()=>parseHostCodexOperation({operation:"usage.read",arguments:{scope:"thread"}}));
  assert.throws(()=>parseHostCodexOperation({operation:"goal.read"}));
  assert.throws(()=>parseHostCodexOperation({operation:"account.logout"}));
  assert.throws(()=>parseHostCodexOperation({operation:"mcp.call",arguments:{name:"n",tool:"t",confirmed:true}}));
  assert.equal(parseHostCodexOperation({operation:"account.read"}).operation,"account.read");
});
test("account native RPC uses no thread, exposes no raw credentials", async () => {
  const calls: unknown[]=[];
  const fake={assertInitialized(){},request:async(method:string,params:unknown)=>{calls.push({method,params});return {account:{type:"chatgpt",planType:"pro",accessToken:"hidden"}}},callbacks:{}};
  const result=await CodexAppServer.prototype.manageHostCodex.call(fake as never,{operation:"account.read"},"mutation");
  assert.deepEqual(calls,[{method:"account/read",params:{refreshToken:false}}]);
  assert.equal(JSON.stringify(result).includes("hidden"),false);
});
test("host mutations are fenced during running tasks and voice, and fence is released", async () => {
  let drain: {operationId:string}|undefined;let calls=0;
  const fake={appServer:{manageHostCodex:async()=>{calls++;return {status:"completed"}}},store:{snapshot:()=>({maintenanceDrain:drain}),setMaintenanceDrain:async(id?:string)=>{drain=id?{operationId:id}:undefined},canSafelyRestart:()=>false}};
  await assert.rejects(AgentRuntime.prototype.manageHostCodex.call(fake as never,{operation:"account.logout",arguments:{confirmed:true}},"test"),/等待/);
  assert.equal(calls,0);assert.equal(drain,undefined);
  await AgentRuntime.prototype.manageHostCodex.call(fake as never,{operation:"account.read"},"read");
  assert.equal(calls,1);assert.equal(drain,undefined);
});

test("extra skill directories persist only after native success and use a version fence", async t => {
 const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
 const { StateStore } = await import("../src/store.js");
 const root = await mkdtemp(join(tmpdir(), "af-extra-skills-")); const directory = join(root, "skills"); await mkdir(directory);
 const store = new StateStore(join(root, "state")); await store.initialize(); t.after(async () => { store.close(); await rm(root,{recursive:true,force:true}); });
 let fail=false;const calls: unknown[]=[];
 const fake={store,appServer:{manageHostCodex:async(value:unknown)=>{calls.push(value);if(fail)throw new Error("native failed");return {operation:"skills.roots.save",status:"savedRequiresReconnect",rows:[]};}}};
 const run=(operation:string,args:Record<string,unknown>={})=>AgentRuntime.prototype.manageHostCodex.call(fake as never,{operation,arguments:args},"test");
 const read=await run("skills.roots.read");const version=(read.codexResult as {rows:{detail:string}[]}).rows[0]!.detail;
 await run("skills.roots.save",{roots:[directory],version,confirmed:true});
 assert.deepEqual(store.snapshot().extraSkillRoots,[directory]);
 await assert.rejects(run("skills.roots.save",{roots:[],version,confirmed:true}),/变化/);
 const latest=await run("skills.roots.read");fail=true;
 await assert.rejects(run("skills.roots.save",{roots:[],version:(latest.codexResult as {rows:{detail:string}[]}).rows[0]!.detail,confirmed:true}),/native failed/);
 assert.deepEqual(store.snapshot().extraSkillRoots,[directory]);assert.equal(calls.length,2);
 store.close();await store.initialize();assert.deepEqual(store.snapshot().extraSkillRoots,[directory]);
});
