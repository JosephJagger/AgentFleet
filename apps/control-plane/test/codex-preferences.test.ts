import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { CodexPreferencesService, parseFieldOverrides } from "../src/codex-preferences.js";
import { PermissionPreferencesService } from "../src/permission-preferences.js";
import type { Principal } from "../src/auth.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "codex-inheritance-")); const path = join(dir, "db.sqlite");
  let db = new ControlPlaneDatabase(path); t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const cfg = loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "prefs@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: path, PUBLIC_ORIGIN: "http://test", COOKIE_SECURE: "false" });
  const { workspaceId } = db.bootstrap(cfg); const at = new Date().toISOString();
  const principal = { workspaceId, userId: db.get<{user_id:string}>("SELECT user_id FROM users LIMIT 1")!.user_id } as Principal;
  const catalog = { models: ["a", "b"].map(model => ({ model, displayName: model, efforts: ["low", "high"], defaultEffort: "low", serviceTiers: [{id:"fast",name:"Fast"}], supportsPersonality: true })), modes: ["default", "plan"], fetchedAt: at };
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at,codex_catalog_json,permission_profiles) VALUES('m',?,'key','fp','host','linux','24','x64','0.30.71','active','normal','online','compatible','idle',?,?,?,1)`, workspaceId,at,at,JSON.stringify(catalog));
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'m','p','project','/work','hash',?,?)`,workspaceId,at,at);
  for (const id of ["s1","s2"]) db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'m','p','session',1,'idle','live',?,?)`,id,workspaceId,at,at);
  return { db, principal, reopen: () => { db.close(); db = new ControlPlaneDatabase(path); return db; }, service: new CodexPreferencesService(db) };
}
test("five-layer field inheritance preserves independent fields, clears and revisions", t => {
  const { service, principal } = fixture(t);
  service.writeTarget(principal,"workspace",principal.workspaceId,{overrides:{model:"a",effort:"low",mode:"plan",serviceTier:"fast"},revision:0});
  service.writeTarget(principal,"machine","m",{overrides:{effort:"high"},revision:0});
  service.writeTarget(principal,"project","p",{overrides:{personality:"friendly"},revision:0});
  const result = service.write(principal,"s1",{scope:"session",overrides:{model:"b",serviceTier:null},revision:0});
  assert.deepEqual(result.desired,{model:"b",effort:"high",mode:"plan",serviceTier:null,personality:"friendly"});
  assert.equal(result.sources.mode,"workspace"); assert.equal(result.sources.effort,"machine");
  assert.equal(service.read(principal,"s2").desired?.model,"a");
  assert.throws(() => service.write(principal,"s1",{scope:"session",overrides:{},revision:0}),/changed in another browser/);
  assert.equal(service.write(principal,"s1",{scope:"session",overrides:{},revision:1}).desired?.model,"a");
  assert.throws(() => service.read({...principal,workspaceId:"other"},"s1"),/not found/);
  assert.equal(service.readTarget({...principal,workspaceId:"other"},"workspace").desired,null);
});
test("legacy whole-group settings never acquire new global fields until restored to inheritance", t => {
  const { db, service, principal } = fixture(t);
  db.run("INSERT INTO codex_preferences(workspace_id,scope,target_id,settings_json,revision,updated_at) VALUES(?,'machine','m',?,4,?)",principal.workspaceId,JSON.stringify({model:"a"}),new Date().toISOString());
  service.writeTarget(principal,"workspace",principal.workspaceId,{overrides:{model:"b",mode:"plan",effort:"high"},revision:0});
  const legacy = service.read(principal,"s1");
  assert.deepEqual(legacy.desired,{model:"a"}); assert.equal(legacy.preferences.machine.overrides.mode,"__native__");
  service.writeTarget(principal,"machine","m",{overrides:{model:"a"},revision:4});
  assert.deepEqual(service.read(principal,"s1").desired,{model:"a",mode:"plan",effort:"high"});
});
test("native value stops inheritance; missing or unsupported models are explicit failures", t => {
  const { db, service, principal } = fixture(t);
  service.writeTarget(principal,"workspace",principal.workspaceId,{overrides:{effort:"high"},revision:0});
  assert.ok(service.read(principal,"s1").resolutionIssue);
  db.run("UPDATE logical_sessions SET runtime_settings_json=? WHERE logical_session_id='s1'",JSON.stringify({observed:{model:"a",observedAt:new Date().toISOString()}}));
  assert.deepEqual(service.read(principal,"s1").desired,{model:"a",effort:"high"});
  service.write(principal,"s1",{scope:"session",overrides:{model:"unknown"},revision:0});
  assert.match(service.read(principal,"s1").compatibilityIssue!,/catalog/);
  service.write(principal,"s1",{scope:"session",overrides:{effort:"__native__"},revision:1});
  assert.equal(service.read(principal,"s1").desired,null);
  assert.throws(()=>parseFieldOverrides({mode:"invalid"})); assert.throws(()=>parseFieldOverrides({permissionProfile:"full"}));
});
test("workspace permissions are independent, confirmed, scoped and revisioned", t => {
  const { db, principal, service } = fixture(t); const permissions = new PermissionPreferencesService(db);
  assert.throws(()=>permissions.write(principal,"workspace","",{scope:"workspace",profile:"full",revision:0}),/确认/);
  permissions.write(principal,"workspace","",{scope:"workspace",profile:"full",revision:0,confirmFullAccess:true});
  assert.equal(permissions.read(principal,"sessions","s1").source,"workspace");
  service.write(principal,"s1",{scope:"session",overrides:{model:"a"},revision:0});
  assert.equal(permissions.read(principal,"sessions","s1").profile,"full");
  permissions.write(principal,"projects","p",{scope:"project",profile:"project",revision:0});
  assert.equal(permissions.read(principal,"sessions","s1").profile,"project");
  assert.throws(()=>permissions.write(principal,"machines","m",{scope:"workspace",profile:"project",revision:1}),/请选择/);
});

test("schema 44 migration and reopen preserve legacy preferences and revisions", t => {
  const f = fixture(t); const at = new Date().toISOString();
  f.db.run("INSERT INTO codex_preferences(workspace_id,scope,target_id,settings_json,revision,updated_at) VALUES(?,'machine','m',?,7,?)", f.principal.workspaceId, JSON.stringify({model:"a"}), at);
  f.db.run("INSERT INTO permission_preferences(workspace_id,scope,target_id,profile,revision,updated_at) VALUES(?,'machine','m','network',3,?)", f.principal.workspaceId, at);
  f.db.sqlite.exec("ALTER TABLE codex_preferences DROP COLUMN field_overrides_json; PRAGMA user_version=44");
  let migrated = f.reopen();
  let service = new CodexPreferencesService(migrated);
  assert.deepEqual(service.read(f.principal,"s1").desired,{model:"a"});
  assert.equal(service.read(f.principal,"s1").preferences.machine.revision,7);
  assert.equal(new PermissionPreferencesService(migrated).read(f.principal,"sessions","s1").profile,"network");
  service.writeTarget(f.principal,"workspace",f.principal.workspaceId,{overrides:{mode:"plan"},revision:0});
  migrated = f.reopen(); service = new CodexPreferencesService(migrated);
  assert.deepEqual(service.read(f.principal,"s1").desired,{model:"a"});
  assert.equal(service.read(f.principal,"s1").preferences.workspace.overrides.mode,"plan");
});
