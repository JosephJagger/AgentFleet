import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlPlaneDatabase} from '../src/db.js';
import {loadConfig} from '../src/config.js';
import {LongTermPreferences,supportsVoicePreferences} from '../src/long-term-preferences.js';
import type {Principal} from '../src/auth.js';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-prefs-')),path=join(dir,'db.sqlite'),db=new ControlPlaneDatabase(path);
 const p=db.bootstrap(loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'preferences@test.example',ADMIN_PASSWORD:'test-only-passphrase',PUBLIC_ORIGIN:'http://test'})) as Principal;
 return {db,p,path,dir,s:new LongTermPreferences(db)};
}
test('explicit rules survive restart with conditions intact; update replaces, delete never restores via retry',t=>{
 const f=fixture();t.after(()=>{f.db.close();rmSync(f.dir,{recursive:true,force:true});});
 const body='先检查英语是否正确自然；有问题先纠正再回应。转写不清时询问原句，不猜测。',conditions='用户用英语表达时';
 const saved=f.s.mutate(f.p,{key:'one',body,conditions});assert.equal(saved.items.length,1);
 assert.equal(f.s.mutate(f.p,{key:'one',body,conditions}).revision,1);
 assert.equal(f.s.mutate(f.p,{key:'two',body,conditions}).items.length,1);
 assert.equal(f.s.list({...f.p,userId:'other'}).items.length,0);
 const id=saved.items[0]!.id;
 assert.throws(()=>f.s.mutate({...f.p,userId:'other'},{revision:1,body:'wrong'},id),/没有此/);
 assert.throws(()=>f.s.mutate(f.p,{revision:0,body:'wrong'},id),/已变化/);
 f.s.mutate(f.p,{revision:1,body:'只在要求时纠正英语'},id);
 assert.equal(f.s.snapshot(f.p).rules.length,1);assert.equal(f.s.snapshot(f.p).rules[0]!.conditions,conditions);
 assert.equal(f.s.snapshot(f.p).resetRevision,2);
 f.db.close();f.db=new ControlPlaneDatabase(f.path);f.s=new LongTermPreferences(f.db);
 assert.equal(f.s.list(f.p).items[0]!.body,'只在要求时纠正英语');
 f.s.mutate(f.p,{revision:2},id,true);
 assert.deepEqual(f.s.snapshot(f.p).rules,[]);
 assert.throws(()=>f.s.mutate(f.p,{key:'one',body,conditions}),/已删除/);
 assert.throws(()=>f.s.mutate(f.p,{key:'two',body,conditions}),/已删除/);
 assert.equal(f.db.get<{body:string}>('SELECT body FROM voice_long_term_preferences WHERE id=?',id)!.body,'');
 assert.doesNotMatch(JSON.stringify(f.db.all('SELECT metadata_json FROM audit_entries')),/先检查英语|只在要求/);
 assert.equal(f.db.all('SELECT * FROM panel_voice_todos').length,0);
});
test('capacity is atomic, no silent truncation; disabled and expired rules do not enter snapshots',t=>{
 const f=fixture();t.after(()=>{f.db.close();rmSync(f.dir,{recursive:true,force:true});});
 const expired=f.s.mutate(f.p,{key:'expired',body:'expired rule',expiresAt:'2000-01-01'}).items[0]!;
 assert.equal(f.s.snapshot(f.p).rules.length,0);
 const disabled=f.s.mutate(f.p,{key:'disabled',body:'disabled rule',enabled:false});
 assert.equal(disabled.rules.length,0);
 for(let i=0;i<3;i++)f.s.mutate(f.p,{key:String(i),body:String(i)+'x'.repeat(1990)});
 const before=f.s.list(f.p);
 assert.throws(()=>f.s.mutate(f.p,{key:'overflow',body:'y'.repeat(2048)}),/8 KiB/);
 assert.equal(f.s.list(f.p).revision,before.revision);assert.deepEqual(f.s.list(f.p).items,before.items);
 assert.throws(()=>f.s.mutate(f.p,{key:'large',body:'汉'.repeat(1000)}),/2 KiB/);
 assert.throws(()=>f.s.tool(f.p,{action:'preference.delete',preferenceId:expired.id,revision:1}),/明确要求/);
 assert.equal(f.db.all('PRAGMA foreign_key_check').length,0);
});

test('HTTP management enforces login and CSRF and never creates task commands',async t=>{
 const {buildControlPlane,cookieFromSetCookie}=await import('../src/server.js');
 const config={...loadConfig({AUTH_MODE:'password',ADMIN_EMAIL:'preferences-api@test.example',ADMIN_PASSWORD:'test-api-passphrase',PUBLIC_ORIGIN:'http://preferences.test',COOKIE_SECURE:'false',LOG_LEVEL:'silent'}),databasePath:':memory:'};
 const {app,db}=await buildControlPlane(config);t.after(async()=>app.close());
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:config.publicOrigin},payload:{email:config.adminEmail,password:config.adminPassword}});
 const cookie=cookieFromSetCookie(login.headers['set-cookie']),headers={cookie,origin:config.publicOrigin,'x-csrf-token':login.json().csrfToken};
 assert.equal((await app.inject({method:'GET',url:'/api/long-term-preferences'})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/long-term-preferences',headers:{cookie},payload:{key:'api',body:'Test rule'}})).statusCode,403);
 const saved=await app.inject({method:'POST',url:'/api/long-term-preferences',headers,payload:{key:'api',body:'Correct English first',conditions:'English speech'}});
 assert.equal(saved.statusCode,200);
 const item=saved.json().items[0];
 const edited=await app.inject({method:'PATCH',url:'/api/long-term-preferences/'+item.id,headers,payload:{revision:item.revision,body:'Only correct when asked'}});
 assert.equal(edited.statusCode,200);
 assert.equal(edited.json().items[0].conditions,'English speech');
 const removed=await app.inject({method:'DELETE',url:'/api/long-term-preferences/'+item.id,headers,payload:{revision:2}});
 assert.equal(removed.statusCode,200);assert.equal(removed.json().items.length,0);
 assert.equal(db.get<{n:number}>('SELECT count(*) n FROM commands')!.n,0);
});

test("preference protocol is never sent to old or unknown agents",()=>{
 for(const version of ["0.30.89","0.29.999","unknown","0.30.90-preview"])assert.equal(supportsVoicePreferences(version),false);
 for(const version of ["0.30.90","0.31.0","1.0.0"])assert.equal(supportsVoicePreferences(version),true);
});

test('voice tool pages bounded records, rejects stale cursors and returns exact mutation receipts',t=>{
 const f=fixture();t.after(()=>{f.db.close();rmSync(f.dir,{recursive:true,force:true});});
 for(let i=0;i<4;i++)f.s.tool(f.p,{action:'preference.save',body:`rule ${i}`,idempotencyKey:`k${i}`,confirmed:true});
 const first=f.s.tool(f.p,{action:'preference.list'}) as {items:{id:string;body:string;revision:number}[];nextCursor:string};
 assert.equal(first.items.length,3);assert.ok(first.nextCursor);
 const next=f.s.tool(f.p,{action:'preference.list',cursor:first.nextCursor}) as {items:unknown[];nextCursor:null};
 assert.equal(next.items.length,1);assert.equal(next.nextCursor,null);
 assert.deepEqual(f.s.snapshot({...f.p,workspaceId:'other-workspace'}).rules,[]);
 const target=first.items[0]!;
 const receipt=f.s.tool(f.p,{action:'preference.update',preferenceId:target.id,revision:target.revision,body:'replacement',confirmed:true}) as {preferenceId:string;entry:{body:string};reconnectRequired:boolean};
 assert.equal(receipt.preferenceId,target.id);assert.equal(receipt.entry.body,'replacement');assert.equal(receipt.reconnectRequired,true);
 assert.throws(()=>f.s.tool(f.p,{action:'preference.list',cursor:first.nextCursor}),/重新读取/);
});
test('fifty effective rules are allowed but the fifty-first is rejected atomically',t=>{
 const f=fixture();t.after(()=>{f.db.close();rmSync(f.dir,{recursive:true,force:true});});
 for(let i=0;i<50;i++)f.s.mutate(f.p,{key:`limit${i}`,body:`rule ${i}`});
 assert.equal(f.s.snapshot(f.p).rules.length,50);
 assert.throws(()=>f.s.mutate(f.p,{key:'limit51',body:'another'}),/50/);
 assert.equal(f.s.snapshot(f.p).revision,50);
});
