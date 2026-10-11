import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {snapshotWorkspace,workspaceChanges} from '../src/workspace-changes.js';
const exec=promisify(execFile);
async function fixture(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'workspace-diff-'));t.after(()=>rm(root,{recursive:true,force:true}));await exec('git',['init',root]);return root;}
test('compares actual shell edits against dirty baseline, includes new and deleted files, survives commit',async t=>{
 const root=await fixture(t);
 await writeFile(join(root,'existing.txt'),'already dirty\n');await writeFile(join(root,'delete.txt'),'old\n');await writeFile(join(root,'unchanged.txt'),'user edits\n');
 await exec('git',['-C',root,'add','.']);
 const index=await readFile(join(root,'.git/index'));const before=await snapshotWorkspace(root);
 await exec(process.execPath,['-e',`require('fs').writeFileSync('existing.txt','already dirty\\nnew line\\n');require('fs').writeFileSync('new.txt','new file\\n');require('fs').unlinkSync('delete.txt')`],{cwd:root});
 const result=workspaceChanges(before,await snapshotWorkspace(root));
 assert.deepEqual(result.changes.map(x=>x.path).sort(),['delete.txt','existing.txt','new.txt']);assert.match(result.changes.find(x=>x.path==='existing.txt')!.diff,/\+new line/);
 assert.deepEqual(await readFile(join(root,'.git/index')),index,'sampling must not change Git index');
 await exec('git',['-C',root,'add','.']);await exec('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture']);
 assert.deepEqual(workspaceChanges(before,await snapshotWorkspace(root)).changes,result.changes,'committing cannot erase captured changes');
});
test('ignores ignored files and never follows symlinks or treats unreadable limits as deletions',async t=>{
 const root=await fixture(t);await writeFile(join(root,'.gitignore'),'secret.txt\n');await writeFile(join(root,'secret.txt'),'secret');
 await writeFile(join(root,'huge.txt'),'x'.repeat(600000));await writeFile(join(root,'binary.bin'),Buffer.from([1,0,2]));
 const outside=await mkdtemp(join(tmpdir(),'outside-diff-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'private'),'private');await symlink(join(outside,'private'),join(root,'link'));
 const before=await snapshotWorkspace(root);assert.equal(before.files.has('secret.txt'),false);assert.equal(before.files.has('link'),false);assert.equal(before.complete,false);
 await writeFile(join(root,'huge.txt'),'small now');
 assert.deepEqual(workspaceChanges(before,await snapshotWorkspace(root)).changes,[]);
});
test('non Git projects and different roots do not invent changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'no-git-diff-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const before=await snapshotWorkspace(root);assert.equal(before.supported,false);assert.deepEqual(workspaceChanges(before,before),{changes:[],limited:true});
});
