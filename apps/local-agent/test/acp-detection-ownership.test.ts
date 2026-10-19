import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {detectAcp,assertAcpUnoccupied,retainReleasedCursorWorkers} from '../src/acp-providers.js';

test('owned read-only detection is not a writer; an unregistered identical process still blocks', {skip:process.platform==='win32'}, async t=>{
 const root=await mkdtemp(join(tmpdir(),'acp-detection-'));
 const binary=join(root,'cursor-agent'),marker=binary+'.ready';
 const prior=process.env.PATH;
 t.after(async()=>{process.env.PATH=prior;await rm(root,{recursive:true,force:true});});
 await writeFile(binary,'#!/bin/sh\necho ready > "$0.ready"\nsleep 2\necho "Cursor 1.2.3"\n',{mode:0o755});
 process.env.PATH=root+':/usr/bin:/bin';
 async function ready(){for(let i=0;i<100;i++){try{await access(marker);return;}catch{await sleep(10);}}throw Error('fixture did not start');}
 const detection=detectAcp('cursor');
 await ready();
 try{await assertAcpUnoccupied('cursor',new Set());}finally{await detection;}
 await rm(marker);
 const external=spawn(binary,['--version'],{stdio:'ignore'});
 const exited=once(external,'close');
 try{
   await ready();
   await assert.rejects(assertAcpUnoccupied('cursor',new Set()),{code:'PROVIDER_NATIVE_BUSY'});
 }finally{await exited;}
 await assertAcpUnoccupied('cursor',new Set());
 assert.equal((await detection)?.executable,binary);
});

test('completed Cursor helper remains owned after its parent exits, without exempting other runtimes', {skip:process.platform!=='linux'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'cursor-worker-test-'));
 const dir=join(root,'cursor-agent','versions','fixture');await mkdir(dir,{recursive:true});
 const file=join(dir,'index.js');await writeFile(file,'setInterval(()=>{},1000);');
 const parent=spawn(process.execPath,['-e',`const c=require('child_process').spawn(process.execPath,[${JSON.stringify(file)},'worker-server'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']});
 const closed=once(parent,'close');const [chunk]=await once(parent.stdout!,'data');const worker=Number(String(chunk).trim());
 t.after(async()=>{parent.kill();try{process.kill(worker);}catch{}await rm(root,{recursive:true,force:true});});
 assert.ok(worker>0);const owned=new Set([parent.pid!]);
 await assertAcpUnoccupied('cursor',owned);
 await retainReleasedCursorWorkers(owned,parent.pid!);
 parent.kill();await closed;owned.delete(parent.pid!);
 await assertAcpUnoccupied('cursor',owned);
 await assert.rejects(assertAcpUnoccupied('cursor',new Set()),{code:'PROVIDER_NATIVE_BUSY'});
});
