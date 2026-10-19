import {isCursorNativeCommand,ownedProcessTree} from '../src/acp-providers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {cursorConfigRoots,listCursorTerminalSessions,prepareCursorTerminalSession} from '../src/cursor-sessions.js';
const id='12345678-1234-4234-8234-123456789abc',version='2026.10.16-e3cb207';
async function fixture(t:import('node:test').TestContext){
 const root=await mkdtemp(join(tmpdir(),'cursor-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'chats','bucket',id);await mkdir(dir,{recursive:true});
 const meta={schemaVersion:1,cwd:root,title:'Native conversation',hasConversation:true,createdAtMs:1,updatedAtMs:2};
 await writeFile(join(dir,'meta.json'),JSON.stringify(meta));
 const db=new DatabaseSync(join(dir,'store.db'));db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)');
 db.prepare('INSERT INTO meta VALUES (?,?)').run('0',Buffer.from(JSON.stringify({agentId:id,latestRootBlobId:'root'})).toString('hex'));
 db.prepare('INSERT INTO blobs VALUES (?,?)').run('root',Buffer.from('synthetic'));db.close();
 return {root,dir,meta};
}
test('Cursor roots follow explicit override, XDG and terminal default without changing PATH',()=>{
 assert.deepEqual(cursorConfigRoots({CURSOR_CONFIG_DIR:'/custom',XDG_CONFIG_HOME:'/xdg'},'/home/test'),['/custom']);
 assert.deepEqual(cursorConfigRoots({XDG_CONFIG_HOME:'/xdg'},'/home/test'),['/xdg/cursor','/home/test/.cursor']);
});
test('discovers actual cwd and excludes empty, malformed, subagent and symlink sidecars',async t=>{
 const f=await fixture(t);let rows=await listCursorTerminalSessions([f.root]);assert.equal(rows.length,1);assert.equal(rows[0]!.cwd,f.root);
 for(const value of [{...f.meta,hasConversation:false},{...f.meta,isSubagent:true},{...f.meta,cwd:'relative'},{...f.meta,schemaVersion:2}]){
  await writeFile(join(f.dir,'meta.json'),JSON.stringify(value));assert.deepEqual(await listCursorTerminalSessions([f.root]),[]);
 }
 if(process.platform==='win32')return;
 await rm(join(f.dir,'meta.json'));await writeFile(join(f.root,'external.json'),JSON.stringify(f.meta));await symlink(join(f.root,'external.json'),join(f.dir,'meta.json'));
 assert.deepEqual(await listCursorTerminalSessions([f.root]),[]);
});
test('directory bridge retains native store identity and CLI metadata; repeated prepare is safe',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),row=(await listCursorTerminalSessions([f.root]))[0]!;
 const before=await readFile(row.database),metaBefore=await readFile(join(f.dir,'meta.json'));
 await prepareCursorTerminalSession(row,version);await prepareCursorTerminalSession(row,version);
 const alias=join(f.root,'acp-sessions',id,'store.db');assert.equal((await lstat(alias)).isSymbolicLink(),true);assert.equal(await realpath(alias),row.database);
 assert.deepEqual(await readFile(row.database),before);assert.deepEqual(await readFile(join(f.dir,'meta.json')),metaBefore);
 const db=new DatabaseSync(alias);db.prepare('INSERT INTO blobs VALUES (?,?)').run('native-update',Buffer.from('same-store'));db.close();
 const original=new DatabaseSync(row.database,{readOnly:true});assert.ok(original.prepare('SELECT 1 FROM blobs WHERE id=?').get('native-update'));original.close();
});
test('unknown version, changed cwd and native ID mismatch fail before mapping',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),row=(await listCursorTerminalSessions([f.root]))[0]!;
 await assert.rejects(prepareCursorTerminalSession(row,'future'),{code:'CURSOR_STORAGE_UNVERIFIED'});
 await writeFile(join(f.dir,'meta.json'),JSON.stringify({...f.meta,cwd:tmpdir()}));
 await assert.rejects(prepareCursorTerminalSession(row,version),{code:'CURSOR_SESSION_CHANGED'});
 await writeFile(join(f.dir,'meta.json'),JSON.stringify(f.meta));
 const db=new DatabaseSync(row.database);db.prepare('UPDATE meta SET value=?').run(Buffer.from(JSON.stringify({agentId:'other',latestRootBlobId:'root'})).toString('hex'));db.close();
 await assert.rejects(prepareCursorTerminalSession(row,version),{code:'CURSOR_STORAGE_UNVERIFIED'});
});
test('never replaces an existing native ACP store',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),row=(await listCursorTerminalSessions([f.root]))[0]!,dest=join(f.root,'acp-sessions',id);
 await mkdir(dest,{recursive:true});await writeFile(join(dest,'store.db'),'existing-native-store');
 await assert.rejects(prepareCursorTerminalSession(row,version),{code:'CURSOR_SESSION_CONFLICT'});
 assert.equal(await readFile(join(dest,'store.db'),'utf8'),'existing-native-store');
});
test('same native ID in distinct config roots is rejected',async t=>{
 const a=await fixture(t),b=await fixture(t);
 await assert.rejects(listCursorTerminalSessions([a.root,b.root]),{code:'CURSOR_SESSION_AMBIGUOUS'});
});

test('Cursor bundled Node and SEA processes count as native writers; Grok does not',()=>{
 for(const command of ['/root/.local/share/cursor-agent/versions/2026.10.16-e3cb207/node /root/.local/share/cursor-agent/versions/2026.10.16-e3cb207/index.js','/root/.local/share/cursor-agent/versions/build/cursor-agent-sea','/root/.local/bin/cursor-agent --resume=id'])assert.equal(isCursorNativeCommand(command),true);
 for(const command of ['/root/.grok/bin/agent','node /root/project/cursor-agent-helper.js','node normal.js','bash -c "/root/.local/bin/cursor-agent --resume=id"','node app.js --prompt /root/.local/bin/cursor-agent'])assert.equal(isCursorNativeCommand(command),false);
});

test('only descendants of live owned writers are excluded, not other Cursor sessions',()=>{
 const own=new Set([10]);const rows=[{pid:12,ppid:11},{pid:11,ppid:10},{pid:20,ppid:1},{pid:21,ppid:20}];
 assert.deepEqual([...ownedProcessTree(rows,own)].sort((a,b)=>a-b),[10,11,12]);assert.deepEqual([...own],[10]);
});
