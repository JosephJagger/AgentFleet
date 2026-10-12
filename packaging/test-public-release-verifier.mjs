import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function verify(t,format,corrupt){
 const routes=new Map();
 for(const [route,file] of [['/install','install.sh'],['/install-macos','install-macos.sh'],['/install.ps1','install.ps1']])routes.set(route,await readFile(new URL(file,import.meta.url)));
 const manifest={schemaVersion:1,version:'0.0.1',artifacts:{}};
 for(const platform of ['linux-x64','darwin-arm64','darwin-x64','win32-x64']){
  const sea=platform==='linux-x64'&&format==='sea',file=`agentfleet-${platform}-0.0.1${sea?'':'.tar.gz'}`,bytes=Buffer.from(`fixture-${platform}`),hash=createHash('sha256').update(bytes).digest('hex');
  manifest.artifacts[platform]={file,format:sea?'sea':'portable',sha256:hash,size:bytes.length};routes.set(`/downloads/${file}`,bytes);routes.set(`/downloads/${file}.sha256`,`${hash}  ${file}\n`);
 }
 if(corrupt==='format')manifest.artifacts['linux-x64'].format='unknown';
 if(corrupt==='size')manifest.artifacts['linux-x64'].size++;
 if(corrupt==='bytes')routes.set('/downloads/'+manifest.artifacts['linux-x64'].file,Buffer.from('altered'));
 routes.set('/downloads/manifest.json',JSON.stringify(manifest));
 const server=createServer((req,res)=>{const value=routes.get(req.url);res.statusCode=value===undefined?404:200;res.end(value);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 return exec(process.execPath,[new URL('verify-published-installers.mjs',import.meta.url).pathname,`http://127.0.0.1:${server.address().port}`,'0.0.1']);
}
for(const format of ['sea','portable'])test(`public verifier accepts supported Linux ${format} and validates all four artifacts`,async t=>{assert.match((await verify(t,format)).stdout,/PASS public release 0.0.1/);});
for(const corrupt of ['format','size','bytes'])test(`public verifier still rejects ${corrupt} mismatch`,async t=>{await assert.rejects(verify(t,'sea',corrupt));});
