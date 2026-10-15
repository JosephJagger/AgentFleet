import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareManagedRuntime, type ManagedRuntimeTarget } from "../src/managed-runtime-update.js";
import { codeModeName } from "../src/managed-code-mode.js";
import { REQUIRED_CODEX_SCHEMA_HASH } from "../src/constants.js";

async function fixture() {
  // Root profile validation requires root-controlled parents; /tmp is deliberately unsafe.
  const dir = await mkdtemp(join(homedir(), ".agentfleet-prepared-test-"));
  const version = "0.153.4", platform = `${process.platform}-${process.arch}`;
  const directory = `${version}-candidate`, stage=join(dir,"codex/releases",directory);
  await mkdir(stage,{recursive:true,mode:0o700});
  await mkdir(join(dir,"old-home"),{mode:0o700}); await writeFile(join(dir,"old-codex"),"old",{mode:0o700});
  const profile={schemaVersion:1,source:"managed",codexExecutable:join(dir,"old-codex"),codexHome:join(dir,"old-home")};
  await writeFile(join(dir,"runtime-profile.json"),JSON.stringify(profile),{mode:0o600});
  const bytes=Buffer.from("synthetic verified file; never executed"), sha256=createHash("sha256").update(bytes).digest("hex");
  const artifact=(kind:string)=>({file:`codex-${kind}-${version}-${sha256.slice(0,16)}${platform==='win32-x64'&&kind!=='bwrap-linux-x64'?'.exe':''}`,sha256,size:bytes.length,format:"raw" as const});
  const target:ManagedRuntimeTarget={schemaVersion:1,revision:randomUUID(),version,schemaHash:REQUIRED_CODEX_SCHEMA_HASH,artifacts:{[platform]:artifact(platform)},codeModeHosts:{[platform]:artifact(`code-mode-host-${platform}`)},...(process.platform==='linux'?{sandboxHelper:artifact('bwrap-linux-x64')}:{})};
  const names=[process.platform==='win32'?'codex.exe':'codex',codeModeName(),...(process.platform==='linux'?['codex-resources/bwrap']:[])];
  if(process.platform==='linux')await mkdir(join(stage,'codex-resources'),{mode:0o700});
  for(const name of names)await writeFile(join(stage,name),bytes,{mode:0o700});
  await writeFile(join(dir,'runtime-prepared.json'),JSON.stringify({key:JSON.stringify(target),directory,profile:JSON.stringify(profile),files:names.map(name=>({name,sha256,size:bytes.length})),...(process.platform==='linux'?{helperHash:sha256}:{})}),{mode:0o600});
  return {dir,target,stage,profile};
}

test("verified prepared files survive an updater restart and activate without another download", async t=>{
  const f=await fixture();t.after(()=>rm(f.dir,{recursive:true,force:true}));
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('verified cache must not download');});
  const options={dataDir:f.dir,controlPlaneUrl:'https://fleet.example',target:f.target};
  await prepareManagedRuntime(options);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,'runtime-profile.json'),'utf8')),f.profile,'prepare never changes current profile');
  const activate=await prepareManagedRuntime(options);
  await activate();
  assert.equal(JSON.parse(await readFile(join(f.dir,'runtime-profile.json'),'utf8')).managedReleaseRevision,f.target.revision);
});

test("prepared activation refuses changed settings and corrupted binaries", async t=>{
  const f=await fixture();t.after(()=>rm(f.dir,{recursive:true,force:true}));
  const activate=await prepareManagedRuntime({dataDir:f.dir,controlPlaneUrl:'https://fleet.example',target:f.target});
  await writeFile(join(f.dir,'runtime-profile.json'),JSON.stringify({...f.profile,source:'host'}),{mode:0o600});
  await assert.rejects(activate(),{code:'RUNTIME_PROFILE_CHANGED'});
  await writeFile(join(f.dir,'runtime-profile.json'),JSON.stringify(f.profile),{mode:0o600});
  await writeFile(join(f.stage,codeModeName()),'corrupt');
  await assert.rejects(activate(),{code:'RUNTIME_CHECKSUM_FAILED'});
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,'runtime-profile.json'),'utf8')),f.profile);
});
