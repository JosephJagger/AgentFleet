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

test('schema 61 runtime-operation migration preserves existing receipts and indexes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'provider-management-migration-'));const path=join(dir,'db.sqlite');const f=fixture(path);t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const at=new Date().toISOString();
 f.db.run(`INSERT INTO machine_operations(operation_id,machine_id,workspace_id,actor_client_session_id,client_mutation_id,type,state,created_at,updated_at,expires_at,result_json) VALUES('old-operation','m',?,?,'unique-mutation','catalog.refresh','succeeded',?,?,?,?)`,f.principal.workspaceId,f.principal.clientSessionId,at,at,at,JSON.stringify({kept:true}));
 const schema=f.db.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='machine_operations'")!.sql;const indexes=f.db.all<{sql:string}>("SELECT sql FROM sqlite_master WHERE tbl_name='machine_operations' AND type='index' AND sql IS NOT NULL");
 f.db.transaction(()=>{f.db.sqlite.exec('ALTER TABLE machine_operations RENAME TO old_ops');f.db.sqlite.exec(schema.replace(",'provider.runtime'",''));f.db.sqlite.exec('INSERT INTO machine_operations SELECT * FROM old_ops; DROP TABLE old_ops');for(const index of indexes)f.db.sqlite.exec(index.sql);f.db.sqlite.exec('PRAGMA user_version=61');});f.db.close();
 const upgraded=new ControlPlaneDatabase(path);t.after(()=>upgraded.close());assert.equal(upgraded.get<{user_version:number}>('PRAGMA user_version')?.user_version,62);
 assert.equal(upgraded.get<{result_json:string}>("SELECT result_json FROM machine_operations WHERE operation_id='old-operation'")?.result_json,JSON.stringify({kept:true}));
 assert.ok(upgraded.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='machine_operations'")?.sql.includes("'provider.runtime'"));assert.equal(upgraded.all('PRAGMA foreign_key_check').length,0);
 for(const index of indexes)assert.ok(upgraded.get('SELECT 1 FROM sqlite_master WHERE sql=?',index.sql));
});

test('provider policy heartbeat preserves newest revision without exposing arbitrary host fields',t=>{
 const f=fixture();t.after(()=>f.db.close());f.registry.updateDiscovery('m',{state:'ready',providerRuntimePolicy:{revision:7,mode:'auto',phase:'waiting_idle',stableVersion:'2.1.292',token:'secret',binaryPath:'/private/claude'}});
 const discovery=JSON.parse(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json);
 assert.deepEqual(discovery.providerRuntimePolicy,{revision:7,mode:'auto',phase:'waiting_idle',stableVersion:'2.1.292'});
 f.registry.updateDiscovery('m',{state:'ready',providerRuntimePolicy:{revision:-1,mode:'evil'}});assert.equal(JSON.parse(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json).providerRuntimePolicy,undefined);
});
