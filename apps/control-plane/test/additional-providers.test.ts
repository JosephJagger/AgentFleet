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
import {CursorPreferencesService} from '../src/cursor-preferences.js';
import {GrokPreferencesService} from '../src/grok-preferences.js';
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
 const upgraded=new ControlPlaneDatabase(path);t.after(()=>upgraded.close());assert.equal(upgraded.get<{user_version:number}>('PRAGMA user_version')?.user_version,68);
 assert.equal(upgraded.get<{result_json:string}>("SELECT result_json FROM machine_operations WHERE operation_id='old-operation'")?.result_json,JSON.stringify({kept:true}));
 assert.ok(upgraded.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='machine_operations'")?.sql.includes("'provider.runtime'"));assert.equal(upgraded.all('PRAGMA foreign_key_check').length,0);
 for(const index of indexes)assert.ok(upgraded.get('SELECT 1 FROM sqlite_master WHERE sql=?',index.sql));
});

test('saved Grok settings inject only after the host can apply them',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const preferences=new GrokPreferencesService(f.db);
 const idle=f.registry.createSession(f.principal,'m','grok',undefined,'grok-inactive-session');
 assert.throws(()=>preferences.write(f.principal,idle.logicalSessionId,{settings:{permissionMode:'default'},revision:0}),{code:'GROK_AGENT_UPDATE_REQUIRED'});
 f.db.run("UPDATE machines SET agent_version='0.30.117' WHERE machine_id='m'");
 assert.deepEqual(preferences.write(f.principal,idle.logicalSessionId,{settings:{permissionMode:'default'},revision:0}).settings,{permissionMode:'default'});
 const lease=f.coordination.acquireLease(f.principal,idle.logicalSessionId);
 f.coordination.createCommand(f.principal,idle.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:'start-grok-off',payload:{prompt:'Inactive settings stay native'},precondition:{executionSegmentId:idle.executionSegmentId,threadControlVersion:idle.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:idle.projectLeaseVersion}});
 const stored=(mutation:string)=>JSON.parse(f.db.get<{body_json:string}>('SELECT cc.body_json FROM commands c JOIN command_contents cc USING(command_id) WHERE c.client_mutation_id=?',mutation)!.body_json).settings;
 assert.equal(stored('start-grok-off'),undefined);
 const at=new Date().toISOString();
 f.db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at,provider) VALUES('grok-2',?,'m','grok-2','grok-2','/fixture/grok-2','grok-2-hash',?,?,'grok')`,f.principal.workspaceId,at,at);
 const active=f.registry.createSession(f.principal,'m','grok-2',undefined,'grok-active-session');
 preferences.write(f.principal,active.logicalSessionId,{settings:{model:'grok-4.6',permissionMode:'always',mode:'plan'},revision:0});
 const activeLease=f.coordination.acquireLease(f.principal,active.logicalSessionId);
 f.coordination.createCommand(f.principal,active.logicalSessionId,{type:'turn.start',controlLeaseId:activeLease.leaseId,clientMutationId:'start-grok-on',payload:{prompt:'Apply saved settings'},precondition:{executionSegmentId:active.executionSegmentId,threadControlVersion:active.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:active.projectLeaseVersion}});
 assert.deepEqual(stored('start-grok-on'),{model:'grok-4.6',permissionMode:'always',mode:'plan'});
});

test('provider policy heartbeat preserves newest revision without exposing arbitrary host fields',t=>{
 const f=fixture();t.after(()=>f.db.close());f.registry.updateDiscovery('m',{state:'ready',providerRuntimePolicy:{revision:7,mode:'auto',phase:'waiting_idle',stableVersion:'2.1.292',token:'secret',binaryPath:'/private/claude'}});
 const discovery=JSON.parse(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json);
 assert.deepEqual(discovery.providerRuntimePolicy,{revision:7,mode:'auto',phase:'waiting_idle',stableVersion:'2.1.292'});
 f.registry.updateDiscovery('m',{state:'ready',providerRuntimePolicy:{revision:-1,mode:'evil'}});assert.equal(JSON.parse(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json).providerRuntimePolicy,undefined);
});

const imageFixture='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
for(const provider of [...ACP_PROVIDER_IDS,'claude'] as const)test(`${provider}: image-only command uses its own capability at admission and dispatch`,t=>{
 const f=fixture();t.after(()=>f.db.close());
 if(provider==='claude'){f.db.run("UPDATE projects SET provider='claude' WHERE project_id='qwen'");f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{claude:{installed:true,version:'2.1.296'}}});}
 else f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{[provider]:{...ready,capabilities:{...ready.capabilities,images:true}}}});
 const s=f.registry.createSession(f.principal,'m',provider==='claude'?'qwen':provider,undefined,`image-${provider}`);
 assert.equal(f.registry.getSession(f.principal,s.logicalSessionId).imageInputSupported,true);
 const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 const input={type:'turn.start' as const,controlLeaseId:lease.leaseId,clientMutationId:`image-start-${provider}`,payload:{prompt:'',images:[imageFixture]},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}};
 const created=f.coordination.createCommand(f.principal,s.logicalSessionId,input);
 assert.equal(f.coordination.createCommand(f.principal,s.logicalSessionId,input).duplicate,true);
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,1);
 const commandId=String(created.command.commandId);
 const target={machineId:'m',transportGeneration:1,producerEpoch:'image-epoch',appServerEpoch:'image-app'};
 assert.ok(f.coordination.createDispatchAttempt(commandId,target),'Codex image catalog is absent but this provider supports images');
});
for(const provider of ACP_PROVIDER_IDS)test(`${provider}: missing images capability refuses input and capability loss invalidates queued delivery`,t=>{
 const f=fixture();t.after(()=>f.db.close());
 const s=f.registry.createSession(f.principal,'m',provider,undefined,`image-loss-${provider}`);
 const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 const input={type:'turn.start' as const,controlLeaseId:lease.leaseId,clientMutationId:`image-loss-${provider}`,payload:{prompt:'Synthetic image',images:[imageFixture]},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}};
 assert.equal(f.registry.getSession(f.principal,s.logicalSessionId).imageInputSupported,false);
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,input),{code:'AGENT_IMAGE_UNSUPPORTED'});
 assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,0);
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{[provider]:{...ready,capabilities:{...ready.capabilities,images:true}}}});
 const created=f.coordination.createCommand(f.principal,s.logicalSessionId,input);
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{[provider]:ready}});
 const commandId=String(created.command.commandId);
 assert.equal(f.coordination.createDispatchAttempt(commandId,{machineId:'m',transportGeneration:1,producerEpoch:'image-epoch',appServerEpoch:'image-app'}),null);
 assert.equal(f.coordination.getCommand(f.principal,commandId).state,'invalidated');
});

test('Grok discovery supplies a bounded native catalog to an empty session without exposing metadata',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{grok:{...ready,models:[{id:'grok-native',name:'Native',efforts:['low','high'],secret:'must not travel'},{id:'invalid model',efforts:['low']}]}}});
 const s=f.registry.createSession(f.principal,'m','grok',undefined,'catalog-draft');
 const prefs=new GrokPreferencesService(f.db).read(f.principal,s.logicalSessionId);
 assert.deepEqual(prefs.models,[{id:'grok-native',name:'Native',efforts:['low','high']}]);
 assert.deepEqual(prefs.options.find(o=>o.id==='model')?.values,['grok-native']);
 assert.equal(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json.includes('must not travel'),false);
 assert.equal(f.db.get<{n:number}>("SELECT count(*) AS n FROM commands")!.n,0);
});

test('Grok discovery retains only validated quota fields and drops raw billing data',t=>{
 const f=fixture();t.after(()=>f.db.close());
 const quota={observedAt:new Date().toISOString(),windows:[{bucket:'grok',window:'primary',usedPercent:4,remainingPercent:96,windowMinutes:10080,resetsAt:Math.floor(Date.now()/1000)+86400}],accessToken:'never-store',history:['never-store']};
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{grok:{...ready,quota,billing:{token:'never-store'}}}});
 const json=f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json;
 assert.equal(JSON.parse(json).agentRuntimes.grok.quota.windows[0].remainingPercent,96);
 assert.equal(json.includes('never-store'),false);
});


for(const provider of ['grok','claude'] as const)test(`${provider} append requires explicit support, exact active turn and deduplicates commands`,t=>{
 const f=fixture();t.after(()=>f.db.close());
 if(provider==='claude'){f.db.run("UPDATE projects SET provider='claude' WHERE project_id='grok'");f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{claude:{installed:true,version:'2.1.296'}}});}
 const s=f.registry.createSession(f.principal,'m','grok','Native append test','steer-test');
 const nativeId=provider==='claude'?'claude_original':'acp_grok_original';
 f.db.run("UPDATE logical_sessions SET active_turn_id='active-turn',execution_state='running' WHERE logical_session_id=?",s.logicalSessionId);
 f.db.run("UPDATE execution_segments SET native_thread_id=? WHERE logical_session_id=?",nativeId,s.logicalSessionId);
 const input={type:'turn.steer' as const,clientMutationId:'append-once',payload:{prompt:'Supplement the current task'},precondition:{nativeTurnId:'active-turn',turnControlVersion:s.turnControlVersion}};
 assert.equal(sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId).steer.allowed,false);
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,input),{code:'AGENT_CAPABILITY_UNAVAILABLE'});
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{[provider]:provider==='claude'?{installed:true,version:'2.1.296',steerSupported:true}:{...ready,capabilities:{...ready.capabilities,steer:true}}}});
 assert.equal(sessionActions(f.db,s.logicalSessionId,f.principal.clientSessionId).steer.allowed,true);
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,clientMutationId:'stale-append-request',precondition:{...input.precondition,nativeTurnId:'old'}}),{code:'ACTIVE_TURN_CONFLICT'});
 f.coordination.createCommand(f.principal,s.logicalSessionId,input);
 assert.equal(f.coordination.createCommand(f.principal,s.logicalSessionId,input).duplicate,true);
 assert.equal(f.db.get<{n:number}>("SELECT count(*) n FROM commands WHERE type='turn.steer'")?.n,1);
});


test('Cursor saved native options enter start commands without changing other providers',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE machines SET agent_version='0.30.127'");
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{cursor:{...ready,cursorModels:[{value:'cursor-native',name:'Native Cursor',configOptions:[]}],grokSecret:'never-forward'}}});
 const stored=JSON.parse(f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json);
 assert.equal(stored.agentRuntimes.cursor.cursorModels[0].value,'cursor-native');assert.equal(stored.agentRuntimes.cursor.grokSecret,undefined);
 const s=f.registry.createSession(f.principal,'m','cursor',undefined,'cursor-prefs');
 const prefs=new CursorPreferencesService(f.db);
 prefs.write(f.principal,s.logicalSessionId,{revision:0,settings:{options:{model:'cursor-native'},permissionMode:'always'}});
 const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 f.coordination.createCommand(f.principal,s.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:'cursor-start',payload:{prompt:'synthetic'},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}});
 const command=f.db.get<{payload_json:string}>("SELECT cc.body_json AS payload_json FROM commands c JOIN command_contents cc USING(command_id) WHERE client_mutation_id='cursor-start'")!;
 assert.deepEqual(JSON.parse(command.payload_json).settings,{options:{model:'cursor-native'},permissionMode:'always'});
 assert.equal(f.db.all('PRAGMA foreign_key_check').length,0);
});

test('Grok native management survives discovery sanitization and enforces exact managed target',t=>{
 const f=fixture();t.after(()=>f.db.close());
 f.db.run("UPDATE machines SET command_types_json='[\"grok.manage\",\"turn.start\"]'");
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{grok:{...ready,nativeManagement:true,commands:[{name:'goal',description:'Native goal',secret:'must-not-leak'}]}}});
 const discovery=f.db.get<{discovery_json:string}>("SELECT discovery_json FROM machines WHERE machine_id='m'")!.discovery_json;
 assert.equal(JSON.parse(discovery).agentRuntimes.grok.nativeManagement,true);assert.equal(discovery.includes('must-not-leak'),false);
 const s=f.registry.createSession(f.principal,'m','grok',undefined,'manage-test');
 f.db.run("UPDATE execution_segments SET native_thread_id='acp_grok_original' WHERE logical_session_id=?",s.logicalSessionId);
 const lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 const input={type:'grok.manage' as const,controlLeaseId:lease.leaseId,clientMutationId:'manage-read',payload:{operation:'tasks.list',arguments:{}},precondition:{nativeThreadId:'acp_grok_original',executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}};
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,clientMutationId:'unconfirmed',payload:{operation:'session.fork',arguments:{}}}),{code:'GROK_OPERATION_INVALID'});
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,clientMutationId:'wrong-target',precondition:{...input.precondition,nativeThreadId:'other'}}),{code:'GROK_TARGET_CHANGED'});
 f.db.run("INSERT INTO panel_voice_calls(voice_id,workspace_id,user_id,owner_id,machine_id,binding_json,state,created_at) VALUES('synthetic-voice',?,?,?,'m','{}','active',?)",f.principal.workspaceId,f.principal.userId,f.principal.clientSessionId,new Date().toISOString());
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,clientMutationId:'during-voice',payload:{operation:'memory.flush',arguments:{},confirmed:true}}),{code:'HOST_BUSY'});
 f.coordination.createCommand(f.principal,s.logicalSessionId,input);
 assert.equal(f.coordination.createCommand(f.principal,s.logicalSessionId,input).duplicate,true);
 assert.throws(()=>f.coordination.createCommand(f.principal,s.logicalSessionId,{...input,clientMutationId:'concurrent'}),{code:'GROK_OPERATION_PENDING'});
});

test('schema 65 upgrade preserves commands, contents, projection and indexes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'grok-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');const f=fixture(path);
 const s=f.registry.createSession(f.principal,'m','grok',undefined,'migration-session'),lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
 f.coordination.createCommand(f.principal,s.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:'migration-command',payload:{prompt:'retain this'},precondition:{executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}});
 const before=f.db.all('SELECT * FROM commands'),contents=f.db.all('SELECT * FROM command_contents'),projection=f.db.all('SELECT * FROM command_projection');
 const schema=f.db.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='commands'")!.sql;
 const indexes=f.db.all<{sql:string}>("SELECT sql FROM sqlite_master WHERE tbl_name='commands' AND type IN ('index','trigger') AND sql IS NOT NULL");
 f.db.sqlite.exec('PRAGMA foreign_keys=OFF');f.db.transaction(()=>{
  f.db.sqlite.exec(schema.replace(/CREATE TABLE ["`]?commands["`]?/i,'CREATE TABLE commands_old_fixture').replace(",'grok.manage'",''));
  f.db.sqlite.exec('INSERT INTO commands_old_fixture SELECT * FROM commands; DROP TABLE commands; ALTER TABLE commands_old_fixture RENAME TO commands');
  for(const i of indexes)f.db.sqlite.exec(i.sql);f.db.sqlite.exec('PRAGMA user_version=65');
 });f.db.close();
 for(let reopen=0;reopen<2;reopen++){
  const db=new ControlPlaneDatabase(path);
  assert.equal(db.get<{user_version:number}>('PRAGMA user_version')?.user_version,68);
  assert.deepEqual(db.all('SELECT * FROM commands'),before);assert.deepEqual(db.all('SELECT * FROM command_contents'),contents);assert.deepEqual(db.all('SELECT * FROM command_projection'),projection);
  for(const i of indexes)assert.ok(db.get('SELECT 1 FROM sqlite_master WHERE sql=?',i.sql));assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);db.close();
 }
});

test('pending Grok reads allow unrelated provider starts; native mutations fence them',t=>{
 for(const write of [false,true]){
  const f=fixture();t.after(()=>f.db.close());f.db.run("UPDATE machines SET command_types_json='[\"grok.manage\",\"turn.start\"]'");
  f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{grok:{...ready,nativeManagement:true},qwen:ready}});
  const s=f.registry.createSession(f.principal,'m','grok',undefined,'read-fence'),lease=f.coordination.acquireLease(f.principal,s.logicalSessionId);
  f.db.run("UPDATE execution_segments SET native_thread_id='acp_grok_original' WHERE logical_session_id=?",s.logicalSessionId);
  f.coordination.createCommand(f.principal,s.logicalSessionId,{type:'grok.manage',controlLeaseId:lease.leaseId,clientMutationId:'read-or-write',payload:{operation:write?'memory.flush':'tasks.list',arguments:{},...(write?{confirmed:true}:{})},precondition:{nativeThreadId:'acp_grok_original',executionSegmentId:s.executionSegmentId,threadControlVersion:s.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:s.projectLeaseVersion}});
  const q=f.registry.createSession(f.principal,'m','qwen',undefined,'other-provider'),ql=f.coordination.acquireLease(f.principal,q.logicalSessionId);
  const start=()=>f.coordination.createCommand(f.principal,q.logicalSessionId,{type:'turn.start',controlLeaseId:ql.leaseId,clientMutationId:'other-start',payload:{prompt:'Synthetic task'},precondition:{executionSegmentId:q.executionSegmentId,threadControlVersion:q.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:q.projectLeaseVersion}});
  if(write)assert.throws(start,{code:'GROK_OPERATION_PENDING'});else assert.doesNotThrow(start);
 }
});

test('extended Grok settings follow live capabilities and startup options lock after native creation',t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.run("UPDATE machines SET agent_version='0.30.135'");
 f.registry.updateDiscovery('m',{state:'ready',agentRuntimes:{grok:{...ready,nativeManagement:true,grokTools:['x_keyword_search','x_semantic_search'],models:[{id:'grok',name:'Grok',efforts:['high'],contextWindows:[256000,500000]}]}}});
 const s=f.registry.createSession(f.principal,'m','grok',undefined,'extended-settings'),prefs=new GrokPreferencesService(f.db);
 assert.equal(prefs.read(f.principal,s.logicalSessionId).canConfigureStartup,true);
 const settings={model:'grok',contextWindow:500000,rules:'Project rule',agentProfile:'reviewer',xSearch:{fromDate:'2026-10-01',toDate:'2026-10-20'}};
 assert.equal(prefs.write(f.principal,s.logicalSessionId,{revision:0,settings}).revision,1);
 assert.throws(()=>prefs.write(f.principal,s.logicalSessionId,{revision:1,settings:{...settings,contextWindow:123}}),{code:'GROK_OPTION_UNAVAILABLE'});
 assert.throws(()=>prefs.write(f.principal,s.logicalSessionId,{revision:1,settings:{...settings,xSearch:{fromDate:'2026-02-31'}}}),{code:'GROK_SETTINGS_INVALID'});
 f.db.run("UPDATE execution_segments SET native_thread_id='acp_grok_existing' WHERE logical_session_id=?",s.logicalSessionId);
 assert.equal(prefs.read(f.principal,s.logicalSessionId).canConfigureStartup,false);
 assert.throws(()=>prefs.write(f.principal,s.logicalSessionId,{revision:1,settings:{...settings,rules:'Replace previous'}}),{code:'GROK_STARTUP_LOCKED'});
 assert.equal(prefs.write(f.principal,s.logicalSessionId,{revision:1,settings:{...settings,contextWindow:256000}}).revision,2);
 assert.throws(()=>prefs.write(f.principal,s.logicalSessionId,{revision:1,settings}),{code:'SETTINGS_REVISION_CONFLICT'});
});
