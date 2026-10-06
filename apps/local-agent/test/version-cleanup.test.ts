import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticVersionCleanup, manageVersions, withVersionLock } from "../src/version-cleanup.js";
async function fixture(platform:NodeJS.Platform="linux") {
 const home=await mkdtemp(join(tmpdir(),"versions-test-")),dataDir=join(home,".local/share/agentfleet"),bin=join(dataDir,"bin");
 await mkdir(join(home,".local/bin"),{recursive:true});
 const old=Date.now()-7_200_000;
 const add=async(path:string,file="agentfleet")=>{await mkdir(path,{recursive:true});await writeFile(join(path,file),"binary");await utimes(path,old/1000,old/1000);};
 for(const v of ["1.0.0","1.0.1","1.0.2","1.0.3"])await add(join(bin,v));
 if(platform==="win32"){await writeFile(join(bin,"current.txt"),"1.0.3");await writeFile(join(bin,"previous.txt"),"1.0.2");}
 else {await symlink(join(bin,"1.0.3/agentfleet"),join(home,".local/bin/agentfleet"));await symlink(join(bin,"1.0.2/agentfleet"),join(home,".local/bin/agentfleet.previous"));}
 const codex=join(dataDir,"codex/releases/1.0.3-current");await add(codex,platform==="win32"?"codex.exe":"codex");
 await add(join(dataDir,"codex/releases/1.0.1-old"),platform==="win32"?"codex.exe":"codex");
 const backup=join(dataDir,"updates/release-backup");await add(backup,"codex");await add(join(dataDir,"updates/release-old"),"codex");
 const profile={codexExecutable:join(codex,platform==="win32"?"codex.exe":"codex"),source:"managed"};
 await writeFile(join(dataDir,"runtime-profile.json"),JSON.stringify(profile));
 await writeFile(join(dataDir,"update-state.json"),JSON.stringify({phase:"succeeded",backupDir:backup,previousTarget:platform==="win32"?"1.0.2":join(bin,"1.0.2/agentfleet")}));
 return {home,dataDir,bin,add,options:{dataDir,home,platform,processReferences:async()=>""},dispose:()=>rm(home,{recursive:true,force:true})};
}
test("preview is read-only; clean preserves current, rollback, process and persisted references",async()=>{
 const f=await fixture();try{
 const options={...f.options,processReferences:async()=>join(f.bin,"1.0.1/runtime/node"),referenceText:""};
 const p=await manageVersions(options);assert.equal(p.entries.find(x=>x.name==="1.0.3")?.reason,"current");assert.equal(p.entries.find(x=>x.name==="1.0.2")?.reason,"rollback");assert.equal(p.entries.find(x=>x.name==="1.0.1")?.reason,"referenced");assert(p.reclaimableBytes>0);assert((await readdir(f.bin)).includes("1.0.0"));
 const r=await manageVersions(options,true);assert.equal(r.deletedCount,2);assert.equal(r.reclaimableBytes,0);assert(!(await readdir(f.bin)).includes("1.0.0"));assert.equal(await readFile(join(f.bin,"1.0.3/agentfleet"),"utf8"),"binary");
 }finally{await f.dispose();}
});
test("Windows current/previous files retain the right versions",async()=>{const f=await fixture("win32");try{const r=await manageVersions(f.options,true);assert.equal(r.deletedCount,3);assert((await readdir(f.bin)).includes("1.0.2"));}finally{await f.dispose();}});
test("upgrade in progress prevents any deletion",async()=>{const f=await fixture();try{await writeFile(join(f.dataDir,"update-state.json"),JSON.stringify({phase:"verifying"}));await assert.rejects(manageVersions(f.options,true),/尚未完成/);assert((await readdir(f.bin)).includes("1.0.0"));}finally{await f.dispose();}});
test("a runtime/profile change between preview and deletion aborts",async()=>{const f=await fixture();try{let calls=0;await assert.rejects(manageVersions({...f.options,processReferences:async()=>{if(++calls===2)await writeFile(join(f.dataDir,"runtime-profile.json"),JSON.stringify({codexExecutable:"/different/codex"}));return "";}},true),/状态已变化/);assert((await readdir(f.bin)).includes("1.0.0"));}finally{await f.dispose();}});
test("symlinks and unknown backup contents are retained",async()=>{const f=await fixture();try{await symlink(f.home,join(f.bin,"1.0.0/link"));await writeFile(join(f.dataDir,"updates/release-old/user-data"),"keep");const r=await manageVersions(f.options,true);assert(r.entries.some(x=>x.name==="1.0.0"&&x.reason==="unsafe"));assert.equal(await readFile(join(f.dataDir,"updates/release-old/user-data"),"utf8"),"keep");}finally{await f.dispose();}});
test("recent directories are deferred; unavailable process evidence fails closed",async()=>{const f=await fixture();try{await utimes(join(f.bin,"1.0.0"),new Date(),new Date());const r=await manageVersions(f.options);assert(r.entries.some(x=>x.name==="1.0.0"&&x.reason==="recent"));await assert.rejects(manageVersions({...f.options,processReferences:async()=>{throw Error("cannot inspect processes");}},true),/cannot inspect/);}finally{await f.dispose();}});
test("upgrade and clean cannot own the lock concurrently",async()=>{const f=await fixture();try{await withVersionLock(f.dataDir,async()=>{await assert.rejects(manageVersions(f.options,true),/正在进行/);});assert((await readdir(f.bin)).includes("1.0.0"));}finally{await f.dispose();}});
test("automatic cleanup persists its result and does not repeatedly rescan the same installation",async()=>{const f=await fixture();try{let scans=0;const o={...f.options,processReferences:async()=>{scans++;return "";}};await automaticVersionCleanup(o);const n=scans;await automaticVersionCleanup(o);assert.equal(scans,n);const r=JSON.parse(await readFile(join(f.dataDir,"version-cleanup.json"),"utf8"));assert.equal(r.automatic,true);assert(r.deletedBytes>0);}finally{await f.dispose();}});

test("automatic cleanup retries recently installed files after the grace period",async()=>{const f=await fixture();try{const now=Date.now();await utimes(join(f.bin,"1.0.0"),new Date(now),new Date(now));await automaticVersionCleanup({...f.options,now});assert((await readdir(f.bin)).includes("1.0.0"));await automaticVersionCleanup({...f.options,now:now+3_600_001});assert(!(await readdir(f.bin)).includes("1.0.0"));}finally{await f.dispose();}});
