import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);
for (const name of ["install.sh","install-macos.sh"]) test(`${name} excludes live installers and recovers a dead owner`, {skip:process.platform==="win32"}, async t => {
  const dir=await mkdtemp(join(tmpdir(),"installer-lock-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL(`../../../../packaging/${name}`,import.meta.url),"utf8");
  const start=source.indexOf("acquire_install_lock() {");const end=source.indexOf("\n}\n",start)+3;
  const script=`set -eu\n${source.slice(start,end)}\nacquire_install_lock\ncat "$INSTALL_LOCK/pid"`;
  const lock=join(dir,"lock");await mkdir(lock);await writeFile(join(lock,"pid"),String(process.pid));
  await assert.rejects(run("/bin/sh",["-c",script],{env:{...process.env,INSTALL_LOCK:lock}}),/another installation is running/);
  // Obtain a real exited PID instead of assuming an arbitrary PID is unused.
  const old=(await run("/bin/sh",["-c","echo $$"])).stdout.trim();
  await writeFile(join(lock,"pid"),old);
  const result=await run("/bin/sh",["-c",script],{env:{...process.env,INSTALL_LOCK:lock}});
  assert.match(result.stdout,/^\d+\s*$/);
  assert.notEqual(result.stdout.trim(),old);
});
