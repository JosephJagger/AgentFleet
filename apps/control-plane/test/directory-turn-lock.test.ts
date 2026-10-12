import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {AuthService} from '../src/auth.js';
import {RegistryService} from '../src/registry.js';
import {CoordinationService} from '../src/coordination.js';
import {sessionActions} from '../src/capabilities.js';
import {directoryProjectIds} from '../src/directory-turn-lock.js';

function fixture() {
  const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'lock@example.test',ADMIN_PASSWORD:'directory-test-password',PUBLIC_ORIGIN:'http://lock.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
  const db=new ControlPlaneDatabase(':memory:');const {workspaceId}=db.bootstrap(config);
  const principal=new AuthService(db,config).servicePrincipal('directory-lock');
  const at=new Date().toISOString();
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,reachability,compatibility,command_types_json,last_heartbeat_at,created_at,updated_at) VALUES('m',?,'key','fingerprint','Mac','linux','24','x64','0.30.97','online','compatible','["turn.start","turn.queue"]',?,?,?)`,workspaceId,at,at,at);
  db.run('UPDATE machines SET discovery_json=?', JSON.stringify({agentRuntimes:{claude:{installed:true}}}));
  const registry=new RegistryService(db,config), coordination=new CoordinationService(db,config);
  const add=(id:string,root:string,provider='codex')=>{
    db.run('INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at,provider) VALUES(?,?,\'m\',?,?,?,?,?,?,?)',id,workspaceId,id,id,root,id,at,at,provider);
    return registry.createSession(principal,'m',id,id,`mutation-${id}`);
  };
  const codex=add('codex','/fixture');const claude=add('claude','/fixture','claude');const worktree=add('worktree','/fixture-other','claude');
  const start=(session:typeof codex,id:string)=>{
    const lease=coordination.acquireLease(principal,session.logicalSessionId);
    return coordination.createCommand(principal,session.logicalSessionId,{type:'turn.start',controlLeaseId:lease.leaseId,clientMutationId:id,payload:{prompt:'Inspect the project'},precondition:{executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:session.projectLeaseVersion}});
  };
  return {db,principal,coordination,codex,claude,worktree,start};
}

test('ordinary commands serialize Codex and Claude in the same physical directory, but allow other worktrees',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.start(f.codex,'codex-start');
  assert.throws(()=>f.start(f.claude,'claude-start'),{code:'PROJECT_TURN_RESERVED'});
  assert.equal(sessionActions(f.db,f.claude.logicalSessionId,f.principal.clientSessionId).start.reasonCode,'PROJECT_TURN_RESERVED');
  assert.equal(sessionActions(f.db,f.worktree.logicalSessionId,f.principal.clientSessionId).start.allowed,true);
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM commands')?.n,1,'rejected command transaction is rolled back');
  f.start(f.worktree,'worktree-start');
  assert.equal(f.db.get<{n:number}>('SELECT count(*) AS n FROM project_turn_reservations')?.n,2);
  f.db.run("UPDATE project_turn_reservations SET state='unknown' WHERE project_id='codex'");
  assert.throws(()=>f.start(f.claude,'claude-retry'),{code:'PROJECT_TURN_RESERVED'});
  f.db.run("DELETE FROM project_turn_reservations WHERE project_id='codex'");
  f.start(f.claude,'claude-after-release');
});

test('unmanaged native activity and uncertain directory owners block a new turn',t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(const state of ['running','awaiting_approval','unknown']) {
    f.db.run('UPDATE logical_sessions SET managed=0,execution_state=? WHERE logical_session_id=?',state,f.claude.logicalSessionId);
    assert.throws(()=>f.start(f.codex,`blocked-${state}`),{code:'PROJECT_TURN_RESERVED'});
  }
  f.db.run("UPDATE logical_sessions SET execution_state='idle' WHERE logical_session_id=?",f.claude.logicalSessionId);
  f.start(f.codex,'idle-external');
});

test('queue promotion rechecks the cross-provider reservation before creating an attempt',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.db.run("UPDATE logical_sessions SET active_turn_id='original',execution_state='running' WHERE logical_session_id=?",f.claude.logicalSessionId);
  f.coordination.createCommand(f.principal,f.claude.logicalSessionId,{type:'turn.queue',clientMutationId:'queue-next-job',payload:{prompt:'Next job'},precondition:{executionSegmentId:f.claude.executionSegmentId,threadControlVersion:f.claude.threadControlVersion,expectedActiveTurnId:'original',projectLeaseVersion:f.claude.projectLeaseVersion,queueVersion:0}});
  f.db.run("UPDATE logical_sessions SET active_turn_id=NULL,execution_state='completed' WHERE logical_session_id=?",f.claude.logicalSessionId);
  f.start(f.codex,'start-between-turns');
  assert.equal(sessionActions(f.db,f.claude.logicalSessionId,f.principal.clientSessionId).queue.reasonCode,'QUEUE_NOT_NEEDED','idle queue is unavailable even with an existing waiting item');
  assert.equal(f.coordination.activateNextQueued(f.claude.logicalSessionId),null);
  assert.equal(f.db.get<{state:string}>('SELECT state FROM turn_queue')?.state,'queued');
  f.db.run("DELETE FROM project_turn_reservations WHERE project_id='codex'");
  assert.ok(f.coordination.activateNextQueued(f.claude.logicalSessionId));
  assert.equal(f.db.get<{state:string}>('SELECT state FROM turn_queue')?.state,'dispatching');
});

test('Windows drive/UNC aliases compare equally without merging sibling paths or Linux case',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.db.run("UPDATE machines SET platform='win32'");
  for (const [a,b] of [['C:\\Work\\Repo','c:/work/repo/'],['\\\\Server\\Share\\Repo','//server/share/repo/']] as const) {
    f.db.run("UPDATE projects SET canonical_root=? WHERE project_id='codex'",a);
    f.db.run("UPDATE projects SET canonical_root=? WHERE project_id='claude'",b);
    assert.deepEqual(new Set(directoryProjectIds(f.db,'codex')),new Set(['codex','claude']));
  }
  f.db.run("UPDATE machines SET platform='linux'");
  f.db.run("UPDATE projects SET canonical_root='/Fixture' WHERE project_id='codex'");
  f.db.run("UPDATE projects SET canonical_root='/fixture' WHERE project_id='claude'");
  assert.deepEqual(directoryProjectIds(f.db,'codex'),['codex']);
});

test('live voice on the other provider locks the directory while its own typed turn remains allowed',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const lease=f.coordination.acquireLease(f.principal,f.codex.logicalSessionId);
  const at=new Date().toISOString();
  f.db.run("INSERT INTO voice_sessions(voice_id,logical_session_id,project_id,machine_id,owner_id,lease_id,binding_json,state,created_at,updated_at) VALUES('voice',?,'codex','m',?,?,'{}','active',?,?)",f.codex.logicalSessionId,f.principal.clientSessionId,lease.leaseId,at,at);
  assert.throws(()=>f.start(f.claude,'voice-conflict'),{code:'PROJECT_TURN_RESERVED'});
  f.start(f.codex,'own-voice-typed');
});


test('queue availability requires an active managed session and project content sync, without taking a directory lock',t=>{
  const f=fixture();t.after(()=>f.db.close());
  const queue=()=>sessionActions(f.db,f.claude.logicalSessionId,f.principal.clientSessionId).queue;
  assert.equal(queue().reasonCode,'QUEUE_NOT_NEEDED');
  f.start(f.codex,'directory-owner');
  f.db.run("UPDATE logical_sessions SET active_turn_id='native-active',execution_state='running' WHERE logical_session_id=?",f.claude.logicalSessionId);
  assert.equal(queue().allowed,true,'existing activity can be queued despite another provider directory reservation');
  f.db.run("UPDATE projects SET sync_content=0 WHERE project_id='claude'");
  assert.equal(queue().reasonCode,'QUEUE_REQUIRES_CONTENT_SYNC');
  f.db.run("UPDATE projects SET sync_content=1 WHERE project_id='claude'");
  f.db.run('UPDATE logical_sessions SET managed=0 WHERE logical_session_id=?',f.claude.logicalSessionId);
  assert.equal(queue().reasonCode,'EXTERNAL_SESSION_READ_ONLY');
  f.db.run('UPDATE logical_sessions SET managed=1 WHERE logical_session_id=?',f.claude.logicalSessionId);
  f.db.run("UPDATE machines SET reachability='offline'");
  assert.equal(queue().reasonCode,'MACHINE_OFFLINE');
});
