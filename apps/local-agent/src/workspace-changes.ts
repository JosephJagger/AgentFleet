import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, relative, isAbsolute, sep} from 'node:path';
const exec=promisify(execFile);
const FILE_LIMIT=512*1024, TOTAL_LIMIT=16*1024*1024, COUNT_LIMIT=2000;
export interface WorkspaceSnapshot {root:string; files:Map<string,string>; listed:Set<string>; complete:boolean; supported:boolean}
const within=(root:string,path:string)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);};
/** Read-only and bounded. Git is only used for an ignore-aware file list, never its index. */
export async function snapshotWorkspace(root:string):Promise<WorkspaceSnapshot> {
 const snapshot:WorkspaceSnapshot={root,files:new Map(),listed:new Set(),complete:true,supported:false};
 try {
  root=await realpath(root);snapshot.root=root;
  const {stdout}=await exec('git',['-C',root,'-c','core.fsmonitor=false','-c','core.untrackedCache=false','ls-files','-z','--cached','--others','--exclude-standard'],{timeout:5000,maxBuffer:1024*1024,encoding:'utf8',windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  snapshot.supported=true;
  const names=[...new Set(stdout.split('\0').filter(Boolean))].sort();
  snapshot.listed=new Set(names);
  if(names.length>COUNT_LIMIT)snapshot.complete=false;
  let total=0;
  const deadline=Date.now()+5000;
  for(const name of names.slice(0,COUNT_LIMIT)) {
   if(Date.now()>deadline){snapshot.complete=false;break;}
   const path=resolve(root,name);
   if(!within(root,path)){snapshot.complete=false;continue;}
   let handle;
   try {
    if(!within(root,await realpath(path))){snapshot.complete=false;continue;}
    handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>FILE_LIMIT||total+stat.size>TOTAL_LIMIT){snapshot.complete=false;continue;}
    const buffer=Buffer.alloc(Math.min(FILE_LIMIT+1,stat.size+1));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if(bytesRead>FILE_LIMIT||bytesRead>stat.size){snapshot.complete=false;continue;}
    const content=buffer.subarray(0,bytesRead);total+=bytesRead;
    if(content.includes(0)){snapshot.complete=false;continue;}
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{snapshot.complete=false;continue;}
    snapshot.files.set(name,text);
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')snapshot.listed.delete(name);else snapshot.complete=false;}
   finally{await handle?.close();}
  }
 }catch{snapshot.complete=false;}
 return snapshot;
}
function patch(path:string,before:string,after:string):string {
 const a=before.split('\n'),b=after.split('\n');let start=0;
 while(start<a.length&&start<b.length&&a[start]===b[start])start++;
 let endA=a.length,endB=b.length;
 while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
 const from=Math.max(0,start-3),toA=Math.min(a.length,endA+3),toB=Math.min(b.length,endB+3);
 return `--- a/${path}\n+++ b/${path}\n@@ -${from+1},${toA-from} +${from+1},${toB-from} @@\n`+
  [...a.slice(from,start).map(x=>' '+x),...a.slice(start,endA).map(x=>'-'+x),...b.slice(start,endB).map(x=>'+'+x),...b.slice(endB,toB).map(x=>' '+x)].join('\n');
}
export function workspaceChanges(before:WorkspaceSnapshot,after:WorkspaceSnapshot) {
 const changes:Array<{path:string;kind:{type:string};diff:string}>=[];
 let limited=!before.complete||!after.complete;
 if(!before.supported||!after.supported||before.root!==after.root)return {changes,limited:true};
 for(const path of new Set([...before.files.keys(),...after.files.keys()])) {
  // A listed but unreadable/oversized/binary file is unknown, never an addition/deletion.
  if((!before.files.has(path)&&before.listed.has(path))||(!after.files.has(path)&&after.listed.has(path)))continue;
  const old=before.files.get(path),next=after.files.get(path);
  if(old===next)continue;
  if(changes.length===30){limited=true;break;}
  const diff=patch(path,old??'',next??'');
  if(diff.length>16000)limited=true;
  changes.push({path,kind:{type:old===undefined?'add':next===undefined?'delete':'update'},diff:diff.slice(0,16000)});
 }
 return {changes,limited};
}
