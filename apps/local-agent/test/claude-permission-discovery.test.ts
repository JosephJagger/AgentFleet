import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectClaudePermissionModes } from '../src/claude-runtime.js';

for (const manual of ['default', 'manual']) {
 test(`reads native ${manual} permission choices from the selected executable`, async t => {
  const dir=await mkdtemp(join(tmpdir(),'claude-permission-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'managed-cli.cjs');
  const help=`--permission-mode <mode> Permission mode (choices: "${manual}", "auto", "acceptEdits", "dontAsk", "bypassPermissions", "plan")`;
  await writeFile(path,`if(process.argv.slice(2).join(' ')!=='--help')process.exit(1);console.log(${JSON.stringify(help)});`);
  assert.deepEqual(await detectClaudePermissionModes(path),['default','auto','acceptEdits','dontAsk']);
 });
}
test('missing capability metadata and failed probes do not invent permissions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-permission-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'cli.cjs');
 await writeFile(path,`console.log('--help Help; --model <model>');`);
 assert.deepEqual(await detectClaudePermissionModes(path),[]);
 await writeFile(path,`process.exit(1)`);
 assert.deepEqual(await detectClaudePermissionModes(path),[]);
 assert.deepEqual(await detectClaudePermissionModes(join(dir,'missing')),[]);
});
