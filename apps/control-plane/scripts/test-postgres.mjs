import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (!process.env.AGENTFLEET_TEST_PG_CONFIG) throw new Error('Set AGENTFLEET_TEST_PG_CONFIG to a private {"url":"postgresql://..."} file for a dedicated test database');
const cwd = fileURLToPath(new URL('..', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('npm', ['run', 'build']);
run(process.execPath, ['--test', '--test-concurrency=3', ...readdirSync(new URL('../dist/test/', import.meta.url)).filter(name => name.endsWith('.test.js')).map(name => `dist/test/${name}`)]);
