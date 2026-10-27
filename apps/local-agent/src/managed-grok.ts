import { Readable } from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {mkdir,readFile,writeFile,rename,rm,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AcpConnection} from './acp-connection.js';
import {AgentError} from './errors.js';
import type {ManagedRelease} from './managed-provider.js';
const exec=promisify(execFile);
export interface GrokInstallation {release:ManagedRelease;sha256:string;}
export function grokFile(root:string,release:ManagedRelease) {return join(root,'provider-runtimes','grok',`${release.version}-${release.id}`,process.platform==='win32'?'grok.exe':'grok');}
export function grokPlatform() {return `${process.platform}-${process.arch}`;}

/** Extract only the known regular binary, never tar paths, links, scripts, or package installers. */
export function grokBinary(archive:Buffer,integrity:string,limit:number,windows=false):Buffer {
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}`!==integrity) throw new AgentError('PROVIDER_DIGEST_MISMATCH','Grok 安装包校验失败');
  const tar=gunzipSync(archive,{maxOutputLength:Math.min(536870912,limit+1024*1024)});
  let binary:Buffer|undefined;let compressed=false;
  for(let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0))break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'');
    const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
    const checksum=parseInt(header.subarray(148,156).toString().trim(),8);
    let actual=0;for(let i=0;i<512;i++)actual+=i>=148&&i<156?32:header[i]!;
    if(actual!==checksum||!Number.isSafeInteger(size)||size<0||size>limit||offset+512+size>tar.length)throw new Error('Invalid package archive');
    const expected=`package/bin/${windows?'grok.exe':'grok'}`;
    if(name===expected||name===`${expected}.br`) {
      if(binary||(header[156]!==0&&header[156]!==48)||header.subarray(345,500).some(b=>b!==0))throw new Error('Invalid package binary');
      binary=tar.subarray(offset+512,offset+512+size);compressed=name.endsWith('.br');
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  if(!binary?.length)throw new Error('Missing package binary');return compressed?brotliDecompressSync(binary,{maxOutputLength:536870912}):binary;
}
export async function prepareGrok(root:string,release:ManagedRelease,signal:AbortSignal,progress:(received:number,total:number)=>void):Promise<GrokInstallation> {
  const platform=grokPlatform(),artifact=release.artifacts[platform];
  if(!artifact)throw new AgentError('PROVIDER_PLATFORM_UNSUPPORTED','当前系统没有可用的 Grok 托管版本');
  const url=`https://registry.npmjs.org/@xai-official/grok-${platform}/-/grok-${platform}-${release.version}.tgz`;
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30*60_000)])});
  if(!r.ok||!r.body)throw new AgentError('PROVIDER_DOWNLOAD_FAILED','Grok 下载暂时不可用');
  const total=Number(r.headers.get('content-length'))||0,chunks:Uint8Array[]=[];let received=0,last=0;
  if(total>536870912)throw new Error('Package too large');
  for await(const chunk of Readable.fromWeb(r.body as import("node:stream/web").ReadableStream)) {received+=chunk.length;if(received>536870912)throw new Error('Package too large');chunks.push(chunk);if(Date.now()-last>1000){last=Date.now();progress(received,total);}}
  const binary=grokBinary(Buffer.concat(chunks),artifact.integrity,artifact.size,process.platform==='win32');
  const file=grokFile(root,release),temp=`${file}.${randomUUID()}.partial`;
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  try{await writeFile(temp,binary,{mode:0o700,flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}
  return {release,sha256:createHash('sha256').update(binary).digest('hex')};
}
export async function verifyGrok(root:string,installation:GrokInstallation):Promise<string> {
  const file=grokFile(root,installation.release);
  if(createHash('sha256').update(await readFile(file)).digest('hex')!==installation.sha256)throw new AgentError('PROVIDER_DIGEST_MISMATCH','Grok 托管文件已变化，请重新安装');
  return file;
}
export async function probeGrok(file:string,version:string,signal:AbortSignal) {
  const result=await exec(file,['--version'],{timeout:10000,maxBuffer:8192,windowsHide:true,signal});
  if(result.stdout.match(/\d+\.\d+\.\d+/)?.[0]!==version)throw new AgentError('PROVIDER_VERSION_MISMATCH','Grok 实际版本与目标不一致');
  const cwd=await mkdtemp(join(tmpdir(),'agentfleet-grok-probe-'));
  const connection=new AcpConnection({executable:file,args:['--no-auto-update','agent','--no-leader','stdio'],cwd,notification:()=>{},request:async()=>{throw new Error('Probe does not authorize requests');},exit:()=>{}});
  const abort=()=>connection.close();signal.addEventListener('abort',abort,{once:true});
  try{signal.throwIfAborted();connection.start();const value=await connection.call('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agentfleets-validation',version:'1.0.0'}},15000) as {protocolVersion?:number;agentCapabilities?:unknown};if(value.protocolVersion!==1||!value.agentCapabilities)throw new AgentError('ACP_INCOMPATIBLE','Grok 协议检查未通过');signal.throwIfAborted();}
  finally{signal.removeEventListener('abort',abort);await connection.closeAndWait();await rm(cwd,{recursive:true,force:true});}
}
