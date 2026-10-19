import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {detectAcp,assertAcpUnoccupied} from '../src/acp-providers.js';

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
