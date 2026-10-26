import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlPlaneDatabase} from './database-fixture.js';
import {loadConfig} from '../src/config.js';
import type {Principal} from '../src/auth.js';
import {CursorPreferencesService} from '../src/cursor-preferences.js';
import {parseCursorSettings,parseCursorOptions} from '../src/cursor-settings.js';

test('Cursor preferences are session/workspace isolated, version checked, revision checked and native validated',t=>{
 const dir=mkdtempSync(join(tmpdir(),"cursor-prefs-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,"db.sqlite");let db=new ControlPlaneDatabase(path);t.after(()=>db.close());
 const cfg=loadConfig({AUTH_MODE:"password",ADMIN_EMAIL:"cursor-prefs@example.test",ADMIN_PASSWORD:randomUUID(),DATABASE_PATH:path,PUBLIC_ORIGIN:"http://test",COOKIE_SECURE:"false"});
 const {workspaceId}=db.bootstrap(cfg);const at=new Date().toISOString();
 const user=db.get<{user_id:string}>("SELECT user_id FROM users LIMIT 1")!;
 const principal={workspaceId,userId:user.user_id} as Principal;
 db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at) VALUES('m',?,'key','fingerprint','host','linux','24','x64','0.30.127','active','normal','online','compatible','idle',?,?)`,workspaceId,at,at);
 db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,provider,created_at,last_reported_at) VALUES('p',?,'m','p','project','/work','hash','cursor',?,?)`,workspaceId,at,at);
 for(const id of ["s1","s2"])db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'m','p','session',1,'idle','live',?,?)`,id,workspaceId,at,at);
 db.run(`INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,created_at) VALUES('seg','s1','m','p',?)`,at);

 const service=new CursorPreferencesService(db);
 assert.equal(service.read(principal,'s1').supported,true);
 assert.equal(service.read(principal,'s1').models.length,0);
 service.record('s1',{effectivePolicy:{cursorOptions:[{id:'model',name:'Model',currentValue:'native',options:[{value:'native',name:'Native model'}]},{id:'mode',name:'Mode',currentValue:'agent',options:['agent','plan','ask']}]}},at);
 assert.equal(service.read(principal,'s1').options[0]?.current,'native');
 const settings={options:{model:'native',mode:'plan'},permissionMode:'always'};
 assert.deepEqual(JSON.parse(JSON.stringify(service.write(principal,'s1',{settings,revision:0}).settings)),settings);
 assert.throws(()=>service.write(principal,'s1',{settings,revision:0}),{code:'SETTINGS_REVISION_CONFLICT'});
 assert.throws(()=>service.write(principal,'s1',{settings:{options:{model:'grok'}},revision:1}),{code:'CURSOR_OPTION_UNAVAILABLE'});
 assert.throws(()=>service.write(principal,'s1',{settings:{permissionMode:'auto'},revision:1}),{code:'CURSOR_SETTINGS_INVALID'});
 assert.throws(()=>service.read({...principal,workspaceId:'other'},'s1'),{code:'SESSION_NOT_FOUND'});
 assert.equal(service.read(principal,'s2').settings,null);
 service.record('s1',{cursorOptions:[]},'2000-01-01T00:00:00Z');
 assert.equal(service.read(principal,'s1').options.length,2);
 db.close();db=new ControlPlaneDatabase(path);
 const reopened=new CursorPreferencesService(db);
 assert.equal(reopened.read(principal,'s1').settings?.options?.mode,'plan');
 assert.equal(reopened.read(principal,'s1').options.length,2);
 db.run("UPDATE machines SET agent_version='0.30.126' WHERE machine_id='m'");
 assert.throws(()=>reopened.write(principal,'s1',{settings,revision:1}),{code:'CURSOR_AGENT_UPDATE_REQUIRED'});
 db.run("UPDATE machines SET agent_version='0.30.127' WHERE machine_id='m'");
 db.run("UPDATE projects SET provider='codex' WHERE project_id='p'");
 assert.throws(()=>reopened.read(principal,'s1'),{code:'CURSOR_SESSION_REQUIRED'});
});

test('Cursor config normalization bounds and labels opaque native ids without accepting arbitrary settings',()=>{
 assert.equal(parseCursorSettings({options:JSON.parse('{"__proto__":"test"}')}),undefined);
 assert.equal(parseCursorSettings({permissionMode:'always',sandbox:'bypass'}),undefined);
 const parsed=parseCursorOptions([{id:'model',type:'select',name:'Model',currentValue:'native/high',options:[{group:'Hosted',options:[{value:'native/high',name:'Native High'}]}]}]);
 assert.equal(parsed[0]?.values[0]?.name,'Native High');
 assert.equal(parsed[0]?.current,'native/high');
});
