import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {sessionActions} from '../src/capabilities.js';
import {ACP_PROVIDER_IDS,unavailableCapabilities} from '../src/provider-catalog.js';
const ready={installed:true,version:'fixture-1.0.0',state:'ready',checkedAt:new Date().toISOString(),capabilities:{...unavailableCapabilities(),create:true,prompt:true,resume:true,history:true,approval:true,input:true,cancel:true}};
function fixture(path=':memory:'){
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'acp@example.test',ADMIN_PASSWORD:'provider-fixture-password',PUBLIC_ORIGIN:'http://provider.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const db=new ControlPlaneDatabase(path);const {workspaceId}=db.bootstrap(config);const principal=new AuthService(db,config).servicePrincipal('additional-providers');
 const at=new Date().toISOString();
 db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Synthetic host','linux','24','x64','0.30.107','online','compatible','["turn.start","turn.queue","thread.claim","thread.release","turn.cancel","turn.steer","codex.manage","approval.decide_once","input.respond"]',?,?,?)`,workspaceId,at,at,at);
 const registry=new RegistryService(db,config),coordination=new CoordinationService(db,config);
 registry.updateDiscovery('m',{state:'ready',agentRuntimes:Object.fromEntries(ACP_PROVIDER_IDS.map(p=>[p,ready]))});
 for(const provider of ACP_PROVIDER_IDS)db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at,provider) VALUES(?,?,'m',?,?,?,?,?,?,?)`,provider,workspaceId,provider,provider,`/fixture/${provider}`,provider,at,at,provider);
 return {db,registry,coordination,principal};
}
test('five providers survive storage and discovery without becoming Codex',t=>{
 const f=fixture();t.after(()=>f.db.close());
 for(const provider of ACP_PROVIDER_IDS){
  const s=f.registry.createSession(f.principal,'m',provider,undefined,`new-${provider}`);
  assert.equal(f.registry.getSession(f.principal,s.logicalSessionId).provider,provider);
  const actions=sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId);
  assert.equal(actions.start.allowed,true);assert.equal(actions.steer.allowed,false);assert.equal(actions.manage.allowed,false);
  const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
  const input={type:'turn.start' as const,controlLeaseId:lease.leaseId,clientMutationId:`start-${provider}`,payload:{prompt:'Synthetic task'},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}};
  f.coordination.createCommand(f.principal,s.logicalSessionId,input);
  assert.equal(f.coordination.createCommand(f.principal,s.logicalSessionId,input).duplicate,true);
  const command=f.db.get<{payload_json:string}>("SELECT payload_json FROM commands WHERE client_mutation_id=?",`start-${provider}`);
  assert.equal(JSON.parse(command!.payload_json).settings,undefined,'Codex preferences must never be injected');
 }
 assert.equal(f.db.all('PRAGMA foreign_key_check').length,0);
 assert.throws(()=>f.db.run("UPDATE projects SET provider='copilot'"));
});
test('unverified native capability and unsupported input never reach a task',t=>{
 const f=fixture();t.after(()=>f.db.close());const s=f.registry.createSession(f.principal,'m','qwen',undefined,'new-qwen-test');
 const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 const input={type:'turn.start' as const,controlLeaseId:lease.leaseId,clientMutationId:'invalid-start',payload:{prompt:'Synthetic',settings:{model:'codex'}},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}};
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,input),{code:'AGENT_INPUT_UNSUPPORTED'});
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{qwen:{...ready,state:'unverified'}}});
 assert.equal(sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId).start.allowed,false);
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,payload:{prompt:'Synthetic'}}),{code:'AGENT_CAPABILITY_UNAVAILABLE'});
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
});

test('independent provider readiness cannot make Codex writable on an incompatible host',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.run("UPDATE machines SET compatibility='incompatible',runtime_read_only=1");
 const s=f.registry.createSession(f.principal,'m','kimi',undefined,'independent-kimi');
 assert.equal(sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId).start.allowed,true);
 f.db.run("UPDATE projects SET provider='codex' WHERE project_id='kimi'");
 assert.equal(sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId).start.allowed,false);
 assert.equal(f.db.get<{compatibility:string}>('SELECT compatibility FROM machines')?.compatibility,'incompatible');
});


test('schema 60 migration preserves project IDs, sessions, references and reopens safely',t=>{
 const dir=mkdtempSync(join(tmpdir(),'providers-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'synthetic.sqlite');const f=fixture(path);
 f.db.run("UPDATE projects SET provider='codex'");const session=f.registry.createSession(f.principal,'m','qwen','Retained synthetic history','before-migration');
 const original=f.db.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'")!.sql;
 const indexes=f.db.all<{sql:string}>("SELECT sql FROM sqlite_master WHERE tbl_name='projects' AND type IN ('index','trigger') AND sql IS NOT NULL");
 f.db.sqlite.exec('PRAGMA foreign_keys=OFF');
 f.db.transaction(()=>{
  f.db.sqlite.exec(original.replace(/CREATE TABLE ["`]?projects["`]?/i,'CREATE TABLE projects_v60').replace("'codex','claude','qwen','kimi','cursor','codebuddy','grok'","'codex','claude'"));
  f.db.sqlite.exec('INSERT INTO projects_v60 SELECT * FROM projects;DROP TABLE projects;ALTER TABLE projects_v60 RENAME TO projects');
  for(const index of indexes)f.db.sqlite.exec(index.sql);f.db.sqlite.exec('PRAGMA user_version=60');
 });f.db.close();
 let upgraded=new ControlPlaneDatabase(path);
 assert.equal(upgraded.get<{n:number}>('SELECT count(*) AS n FROM projects')?.n,5);
 assert.equal(upgraded.get<{title:string}>('SELECT title FROM logical_sessions WHERE logical_session_id=?',session.logicalSessionId)?.title,'Retained synthetic history');
 assert.deepEqual(upgraded.all('PRAGMA foreign_key_check'),[]);
 upgraded.run("UPDATE projects SET provider='qwen' WHERE project_id='qwen'");upgraded.close();upgraded=new ControlPlaneDatabase(path);
 assert.equal(upgraded.get<{provider:string}>("SELECT provider FROM projects WHERE project_id='qwen'")?.provider,'qwen');upgraded.close();
});
