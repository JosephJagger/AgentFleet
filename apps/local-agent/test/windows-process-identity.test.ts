import assert from 'node:assert/strict';
import test from 'node:test';
import {windowsProcessStartToken} from '../src/windows-process-identity.js';
const timeout=()=>Object.assign(new Error('query timeout'),{killed:true,signal:'SIGTERM',code:null});
test('a timed-out identity query is retried once using the same PID and exact token',async()=>{
 const pids:number[]=[],reports:unknown[]=[];
 const result=await windowsProcessStartToken(42,async pid=>{pids.push(pid);if(pids.length===1)throw timeout();return ' 638959831234567890\r\n';},data=>reports.push(data));
 assert.equal(result,'windows:638959831234567890');assert.deepEqual(pids,[42,42]);assert.deepEqual(reports,[{attempt:1,reason:'timeout',timeoutMs:8000}]);
});
test('repeated timeouts remain unavailable after two bounded attempts',async()=>{
 let calls=0;const reports:unknown[]=[];
 assert.equal(await windowsProcessStartToken(42,async()=>{calls++;throw timeout();},data=>reports.push(data)),undefined);
 assert.equal(calls,2);assert.equal(reports.length,2);
});
test('missing, denied, malformed, oversized and spawn-failed identities never get a fallback',async()=>{
 for(const value of ['', 'Access denied', 'windows:123',new Error('denied'),{killed:true,signal:'SIGTERM',code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},{code:1},{code:'ENOENT'}]){
  let calls=0;
  assert.equal(await windowsProcessStartToken(42,async()=>{calls++;if(typeof value==='string')return value;throw value;},()=>{}),undefined);
  assert.equal(calls,1);
 }
});
test('invalid PIDs do not launch a process',async()=>{
 for(const pid of [0,-1,NaN,1.5])assert.equal(await windowsProcessStartToken(pid,async()=>{assert.fail('must not query');}),undefined);
});
