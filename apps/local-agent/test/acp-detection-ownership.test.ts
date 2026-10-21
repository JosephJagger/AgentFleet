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
 t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'cursor-agent','versions','fixture');await mkdir(dir,{recursive:true});
 const file=join(dir,'index.js');
 // These intentionally native-looking fixtures must not survive a failed or
 // killed test runner and freeze real sessions through ownership detection.
 // Keep the worker alive after its immediate parent exits (the behavior under
 // test), but bind both processes to this test's owner and fixture lifetime.
 const watchdog=`setInterval(()=>{try{process.kill(${process.pid},0);if(!require('fs').existsSync(${JSON.stringify(file)}))process.exit(0);}catch{process.exit(0);}},100);setTimeout(()=>process.exit(0),30000);`;
 await writeFile(file,watchdog);
 const parent=spawn(process.execPath,['-e',`${watchdog}const c=require('child_process').spawn(process.execPath,[${JSON.stringify(file)},'worker-server'],{stdio:'ignore'});console.log(c.pid);`],{stdio:['ignore','pipe','ignore']});
 let worker:number|undefined;
 // Register cleanup before awaiting readiness: startup failures must not leak.
 t.after(()=>{parent.kill();if(worker)try{process.kill(worker);}catch{}});
 const closed=once(parent,'close');const [chunk]=await once(parent.stdout!,'data');worker=Number(String(chunk).trim());
 assert.ok(worker>0);const owned=new Set([parent.pid!]);
 await assertAcpUnoccupied('cursor',owned);
 await retainReleasedCursorWorkers(owned,parent.pid!);
 parent.kill();await closed;owned.delete(parent.pid!);
 await assertAcpUnoccupied('cursor',owned);
 await assert.rejects(assertAcpUnoccupied('cursor',new Set()),{code:'PROVIDER_NATIVE_BUSY'});
 // No cleanup signal: deleting the fixture alone must retire the orphan.
 await rm(root,{recursive:true,force:true});
 let running=true;
 for(let i=0;i<100&&running;i++){
   try{await assertAcpUnoccupied('cursor',new Set());running=false;}catch{await sleep(20);}
 }
 assert.equal(running,false,'orphan worker must self-terminate when its fixture is removed');
 worker=undefined;
});
