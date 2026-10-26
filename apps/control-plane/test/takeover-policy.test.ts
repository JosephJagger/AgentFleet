import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDatabase } from "./database-fixture.js";
import { loadConfig } from "../src/config.js";
import { TakeoverPolicy } from "../src/takeover-policy.js";
import type { Principal } from "../src/auth.js";

test("independent takeover policy persists, isolates workspaces and rejects stale or invalid saves", t => {
  const directory=mkdtempSync(join(tmpdir(),"takeover-policy-")),path=join(directory,"db.sqlite");
  let db=new ControlPlaneDatabase(path);
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const owner=db.bootstrap(loadConfig({AUTH_MODE:"password",ADMIN_EMAIL:"owner@example.test",ADMIN_PASSWORD:"correct horse battery staple",PUBLIC_ORIGIN:"http://example.test",COOKIE_SECURE:"false",LOG_LEVEL:"silent"}));
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('synthetic',?,?,'token','csrf',?,?,?)",owner.workspaceId,owner.userId,new Date().toISOString(),new Date().toISOString(),new Date(Date.now()+86400000).toISOString());
  const principal={...owner,clientSessionId:"synthetic",email:"owner@example.test",csrfHash:"",expiresAt:""} as Principal;
  let service=new TakeoverPolicy(db);
  assert.deepEqual(service.read(owner.workspaceId),{idleDays:14,revision:0});
  for(const idleDays of [0,31,1.5,"14",null]) assert.throws(()=>service.save(principal,{idleDays,revision:0}),{code:"INVALID_TAKEOVER_POLICY"});
  service.save(principal,{idleDays:21,revision:0});
  assert.throws(()=>service.save(principal,{idleDays:7,revision:0}),{code:"SETTINGS_REVISION_CONFLICT"});
  assert.deepEqual(service.read("other-workspace"),{idleDays:14,revision:0});
  assert.equal(db.get<{count:number}>("SELECT count(*) AS count FROM audit_entries WHERE action='takeover.policy.update'")?.count,1);
  db.close();db=new ControlPlaneDatabase(path);service=new TakeoverPolicy(db);
  assert.deepEqual(service.read(owner.workspaceId),{idleDays:21,revision:1});
  service.save(principal,{idleDays:1,revision:1});service.save(principal,{idleDays:30,revision:2});
});

test("policy HTTP routes require login and CSRF, and preserve stale-save conflicts", async t => {
  const {buildControlPlane}=await import("./server-fixture.js");
  const origin="http://example.test";
  const {app}=await buildControlPlane({...loadConfig({AUTH_MODE:"password",ADMIN_EMAIL:"owner@example.test",ADMIN_PASSWORD:"correct horse battery staple",PUBLIC_ORIGIN:origin,COOKIE_SECURE:"false",LOG_LEVEL:"silent"}),databasePath:":memory:"});
  t.after(()=>app.close());
  const url="/api/settings/takeover-policy";
  assert.equal((await app.inject({method:"GET",url})).statusCode,401);
  assert.equal((await app.inject({method:"PUT",url,payload:{idleDays:7,revision:0}})).statusCode,401);
  const login=await app.inject({method:"POST",url:"/api/auth/login",headers:{origin},payload:{email:"owner@example.test",password:"correct horse battery staple"}});
  assert.equal(login.statusCode,200,login.body);
  const cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join("; ");
  const headers={cookie,origin,"x-csrf-token":login.json().csrfToken};
  assert.deepEqual((await app.inject({method:"GET",url,headers:{cookie}})).json(),{idleDays:14,revision:0});
  assert.equal((await app.inject({method:"PUT",url,headers:{cookie,origin},payload:{idleDays:7,revision:0}})).statusCode,403);
  assert.equal((await app.inject({method:"PUT",url,headers,payload:{idleDays:7,revision:0}})).statusCode,200);
  assert.equal((await app.inject({method:"PUT",url,headers,payload:{idleDays:14,revision:0}})).statusCode,409);
  assert.equal((await app.inject({method:"PUT",url,headers,payload:{idleDays:31,revision:1}})).statusCode,400);
});
