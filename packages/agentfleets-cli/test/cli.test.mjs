import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { main, parseArgs, layoutFor, inspectInstallation, installerCommand, runCommand, VERSION } from '../src/cli.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = overrides => ({ platform: 'linux', arch: 'x64', env: { HOME: '/users/test person' }, home: '/users/test person', uid: 1001, ...overrides });
const fakeIo = () => {
  const entries = new Map();
  const missing = () => { throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' }); };
  return {
    entries,
    add(file, type = 'file', contents = '', target) { entries.set(file, { type, contents, target }); },
    async lstat(file) {
      const value = entries.get(file) ?? missing();
      return { isFile: () => value.type === 'file', isDirectory: () => value.type === 'dir', isSymbolicLink: () => value.type === 'link', mode: 0o755 };
    },
    async realpath(file) { const value = entries.get(file) ?? missing(); if (value.type === 'link' && !entries.has(value.target)) missing(); return value.target ?? file; },
    async readFile(file) { return (entries.get(file) ?? missing()).contents; },
  };
};

function installedFixture(platform = 'linux') {
  const ctx = platform === 'win32' ? context({ platform, env: { LOCALAPPDATA: 'C:\\Users\\Test Person\\AppData\\Local', SystemRoot: 'C:\\Windows' }, home: 'C:\\Users\\Test Person' }) : context({ platform });
  const layout = layoutFor(ctx);
  const io = fakeIo();
  for (const dir of [layout.dataRoot, layout.binRoot, layout.paths.dirname(layout.launcher)]) io.add(dir, 'dir');
  const version = '0.30.102';
  const target = layout.paths.join(layout.binRoot, version, 'agentfleet');
  if (platform !== 'win32') {
    io.add(target);
    io.add(layout.launcher, 'link', '', target);
    if (platform === 'linux') io.add(layout.paths.join(layout.binRoot, '.managed-by-agentfleet'), 'file', 'agentfleet-binaries-v1\n');
  }
  return { ctx, layout, io, target, version };
}

test('argument parser normalizes URL, accepts Unicode, and never echoes unknown or sensitive arguments', () => {
  assert.deepEqual(parseArgs(['connect', '--url=https://panel.example/', '--ticket', 'one.secret', '--name', '测试 主机', '--project', '/my project']), { command: 'connect', values: { url: 'https://panel.example', ticket: 'one.secret', name: '测试 主机', project: '/my project' } });
  for (const argv of [ ['connect'], ['connect', '--url', 'https://panel.example?token=secret'], ['connect', '--url', 'http://other.example'], ['connect', '--url', 'https://user:secret@panel.example'], ['connect', '--url', 'https://panel.example', '--ticket', 'value\nother'], ['connect', '--url', 'https://panel.example', '--url', 'https://second.example'], ['status', '--ticket', 'private.secret'], ['private.secret'], ['connect', '--url', 'https://panel.example', '--unknown=private.secret'] ]) {
    assert.throws(() => parseArgs(argv), error => !error.message.includes('private.secret') && !error.message.includes('user:secret'));
  }
  assert.equal(parseArgs(['connect', '--url', 'http://localhost:5000']).values.url, 'http://localhost:5000');
  assert.equal(parseArgs(['connect', '--url', 'http://127.0.0.1:5000']).command, 'connect');
});

test('platform layouts match native paths including root Linux normalization', () => {
  const linux = layoutFor(context());
  assert.equal(linux.launcher, '/users/test person/.local/bin/agentfleet');
  assert.equal(layoutFor(context({ uid: 0, env: { HOME: '/untrusted', XDG_DATA_HOME: '/untrusted/data' } })).dataRoot, '/root/.local/share/agentfleet');
  assert.equal(layoutFor(context({ platform: 'darwin', arch: 'arm64' })).dataRoot, '/users/test person/Library/Application Support/AgentFleet');
  assert.equal(layoutFor(context({ platform: 'win32', home: 'C:\\Users\\Viewer', env: { LOCALAPPDATA: 'C:\\Users\\Viewer\\AppData\\Local' } })).launcher, 'C:\\Users\\Viewer\\AppData\\Local\\AgentFleet\\agentfleet.cmd');
  for (const ctx of [context({ arch: 'arm64' }), context({ platform: 'freebsd' }), context({ env: { HOME: '/users/test', XDG_DATA_HOME: 'relative' } }), context({ env: { HOME: '/users/test', AGENTFLEET_HOME: '/custom' } })]) assert.throws(() => layoutFor(ctx));
});

test('only a verified managed launcher is executable; data/cache directories alone permit retry', async () => {
  const { io, layout } = installedFixture();
  assert.equal((await inspectInstallation(layout, io)).kind, 'installed');
  io.entries.delete(layout.launcher);
  io.add(layout.paths.join(layout.dataRoot, 'download-cache'), 'dir');
  assert.equal((await inspectInstallation(layout, io)).kind, 'absent');
  for (const file of ['state.sqlite', 'state.json', 'machine-ed25519.pem', 'runtime-profile.json']) {
    const candidate = layout.paths.join(layout.dataRoot, file);
    io.add(candidate);
    assert.equal((await inspectInstallation(layout, io)).kind, 'conflict');
    io.entries.delete(candidate);
  }
  io.add(layout.previous, 'link', '', '/missing');
  assert.equal((await inspectInstallation(layout, io)).kind, 'conflict');
});

test('custom, broken, escaped or modified launchers are refused without reading state', async () => {
  for (const mutate of [
    ({ io, layout }) => io.add(layout.launcher, 'file', 'custom executable'),
    ({ io, layout }) => io.add(layout.launcher, 'link', '', '/missing'),
    ({ io, layout }) => { io.add('/unmanaged/program'); io.add(layout.launcher, 'link', '', '/unmanaged/program'); },
    ({ io, layout }) => io.add(layout.binRoot, 'link', '', '/other'),
    ({ io, layout }) => io.add(layout.paths.join(layout.binRoot, '.managed-by-agentfleet'), 'file', 'invalid marker'),
  ]) {
    const fixture = installedFixture();
    mutate(fixture);
    assert.equal((await inspectInstallation(fixture.layout, fixture.io)).kind, 'conflict');
  }
});

test('macOS managed launcher validates without the Linux-only marker', async () => {
  const fixture = installedFixture('darwin');
  assert.equal((await inspectInstallation(fixture.layout, fixture.io)).kind, 'installed');
});

test('Windows validates stable pointer/launchers and bypasses cmd for status', async () => {
  const fixture = installedFixture('win32');
  const { io, layout, version } = fixture;
  io.add(layout.launcher, 'file', '@echo off\r\nsetlocal\r\nset /p AGENTFLEET_CURRENT=<"%~dp0bin\\current.txt"\r\ncall "%~dp0bin\\%AGENTFLEET_CURRENT%\\agentfleet.cmd" %*\r\nexit /b %errorlevel%\r\n');
  io.add(layout.pointer, 'file', version);
  const target = layout.paths.join(layout.binRoot, version);
  for (const dir of [target, layout.paths.join(target, 'runtime'), layout.paths.join(target, 'lib/dist/src')]) io.add(dir, 'dir');
  io.add(layout.paths.join(target, 'agentfleet.cmd'), 'file', await fs.readFile(path.join(root, 'dist/installers/windows-launcher.cmd'), 'utf8'));
  io.add(layout.paths.join(target, 'runtime/node.exe'));
  io.add(layout.paths.join(target, 'lib/dist/src/cli.js'));
  const result = await inspectInstallation(layout, io);
  assert.equal(result.kind, 'installed');
  assert.equal(result.file, layout.paths.join(target, 'runtime/node.exe'));
  assert.deepEqual(result.prefix, [layout.paths.join(target, 'lib/dist/src/cli.js')]);
  for (const value of ['..\\outside', '0.30.102 & calc', 'C:\\outside\\agentfleet.cmd']) {
    io.add(layout.pointer, 'file', value);
    assert.equal((await inspectInstallation(layout, io)).kind, 'conflict');
  }
});

test('POSIX receives literal argv; Windows uses fixed code plus JSON and rejects downstream cmd metacharacters', () => {
  const evil = "test'; touch /tmp/SHOULD_NOT_EXIST; $(id) `id`";
  const values = { url: 'https://panel.example', name: evil, project: '/my 中文 path', ticket: 'ticket.secret' };
  const command = installerCommand(context(), values);
  assert.equal(command.file, '/bin/sh');
  assert.equal(command.args[command.args.indexOf('--name') + 1], evil);
  assert.equal(command.env.AGENTFLEET_NPM_FRESH_INSTALL, '1');
  const winContext = context({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  const winValues = { url: 'https://panel.example', name: "Viewer's 中文 PC", project: 'C:\\Users\\Viewer\\my project', ticket: 'ticket.secret' };
  const win = installerCommand(winContext, winValues);
  assert.deepEqual(JSON.parse(win.env.AGENTFLEETS_NPM_INSTALL_ARGS).values, winValues);
  const code = Buffer.from(win.args.at(-1), 'base64').toString('utf16le');
  assert.ok(!code.includes(winValues.name) && !code.includes(winValues.ticket));
  assert.match(code, /ConvertFrom-Json/);
  assert.match(code, /Remove-Item Env:AGENTFLEETS_NPM_INSTALL_ARGS/);
  for (const value of ['%PATH%', '!PATH!', 'a&calc', 'a|calc', 'a<file', 'a>file', '^a', '"a"', '(a)']) assert.throws(() => installerCommand(winContext, { ...winValues, name: value }));
});

test('Windows validates and passes effective project/name defaults before invoking native installer', async () => {
  const winContext = context({ platform: 'win32', cwd: 'C:\\Users\\Viewer\\中文 project', hostname: 'Viewer PC', env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\Viewer\\AppData\\Local' }, home: 'C:\\Users\\Viewer' });
  const values = { url: 'https://panel.example' };
  const effective = JSON.parse(installerCommand(winContext, values).env.AGENTFLEETS_NPM_INSTALL_ARGS).values;
  assert.deepEqual(effective, { ...values, project: winContext.cwd, name: winContext.hostname });
  assert.deepEqual(values, { url: 'https://panel.example' });
  for (const unsafe of ['C:\\my%PATH%folder', 'C:\\my!PATH!folder', 'C:\\my&folder', 'C:\\my(parentheses)folder']) {
    assert.throws(() => installerCommand({ ...winContext, cwd: unsafe }, values));
    assert.throws(() => installerCommand({ ...winContext, cwd: unsafe }, { ...values, project: 'C:\\safe' }));
  }
  for (const unsafe of ['PC%PATH%', 'PC!PATH!', 'PC&other', 'PC\nother']) assert.throws(() => installerCommand({ ...winContext, hostname: unsafe }, values));
  const safeOverride = JSON.parse(installerCommand({ ...winContext, hostname: 'unsafe%host%' }, { ...values, name: 'Safe Name' }).env.AGENTFLEETS_NPM_INSTALL_ARGS).values;
  assert.equal(safeOverride.name, 'Safe Name');
  const calls = [];
  const code = await main(['connect', '--url', 'https://panel.example'], { ...winContext, cwd: 'C:\\my%PATH%folder', io: fakeIo(), run: async (...args) => { calls.push(args); return { code: 0 }; }, out: () => {}, err: () => {} });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test('existing installation uses only read-only commands and never consumes ticket or invokes installer', async () => {
  const { ctx, io, version, target } = installedFixture();
  const calls = [];
  let output = '';
  const run = async (file, args) => { calls.push({ file, args }); return args[0] === '--version' ? { code: 0, stdout: `${version}\n` } : { code: 0, stdout: JSON.stringify({ installed: true, active: true }) }; };
  assert.equal(await main(['connect', '--url', 'https://panel.example', '--ticket', 'never.send.this'], { ...ctx, io, run, out: value => output += value, err: value => output += value }), 0);
  assert.deepEqual(calls, [{ file: target, args: ['--version'] }, { file: target, args: ['service', 'status', '--json'] }]);
  assert.match(output, /did not use the ticket/);
  assert.ok(!output.includes('never.send.this'));
  assert.match(output, /does not prove an online connection/);
});

test('absent installation delegates exactly once; failed-before-activation can retry', async () => {
  const ctx = context();
  const io = fakeIo();
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { code: calls.length === 1 ? 1 : 0 }; };
  const output = [];
  const argv = ['connect', '--url', 'https://panel.example', '--project', '/my project'];
  assert.equal(await main(argv, { ...ctx, io, run, out: t => output.push(t), err: t => output.push(t) }), 1);
  assert.equal(await main(argv, { ...ctx, io, run, out: t => output.push(t), err: t => output.push(t) }), 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.args.includes('--ticket')));
  assert.match(output.join(''), /Confirm the host appears online/);
});

test('uncertain existing state and version mismatch do not invoke native installer', async () => {
  const { ctx, io, layout } = installedFixture();
  const calls = [];
  const run = async (file, args) => { calls.push(args); return { code: 0, stdout: '0.0.1' }; };
  const options = { ...ctx, io, run, out: () => {}, err: () => {} };
  assert.equal(await main(['connect', '--url', 'https://panel.example'], options), 1);
  assert.deepEqual(calls, [['--version']]);
  io.entries.delete(layout.launcher);
  io.add(layout.service);
  calls.length = 0;
  assert.equal(await main(['connect', '--url', 'https://panel.example'], options), 1);
  assert.deepEqual(calls, []);
});

test('real filesystem rejects symlink escapes and detects a safe managed version', { skip: process.platform === 'win32' }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'agentfleets-cli-fs-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const layout = layoutFor(context({ env: { HOME: home }, home }));
  const target = path.join(layout.binRoot, '1.2.3', 'agentfleet');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(path.dirname(layout.launcher), { recursive: true });
  await fs.writeFile(target, 'synthetic; never executed', { mode: 0o755 });
  await fs.writeFile(path.join(layout.binRoot, '.managed-by-agentfleet'), 'agentfleet-binaries-v1\n');
  await fs.symlink(target, layout.launcher);
  assert.equal((await inspectInstallation(layout)).kind, 'installed');
  await fs.unlink(layout.launcher);
  await fs.symlink('/tmp/unmanaged', layout.launcher);
  assert.equal((await inspectInstallation(layout)).kind, 'conflict');
});

test('runner preserves literal argv and redacts secrets even across output chunks', async () => {
  let output = '';
  const value = "a; $(echo SHOULD_NOT_RUN) ' 中文";
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1]+"\\n"); process.stdout.write("synthetic."); setTimeout(() => process.stdout.write("ticket\\n"), 10)', value], { interactive: true, secrets: ['synthetic.ticket'], output: text => output += text });
  assert.equal(result.code, 0);
  assert.ok(output.includes(value));
  assert.ok(!output.includes('synthetic.ticket'));
  assert.match(output, /\[redacted\]/);
  assert.equal((await runCommand('/definitely/missing/agentfleets', [])).code, 1);
});

test('actual POSIX shell handoff preserves special characters as arguments', { skip: process.platform === 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'agentfleets-argv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'synthetic installer.sh');
  await fs.writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  const values = { url: 'https://panel.example', name: "中文'; $(echo UNEXPECTED) `id`", project: '/space path' };
  const command = installerCommand(context(), values);
  const args = [script, ...command.args.slice(1)];
  const result = await runCommand(command.file, args, { env: process.env });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.trimEnd().split('\n'), args.slice(1));
});

test('actual Windows PowerShell bridge preserves Unicode/spaces/apostrophes without executing data', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'agentfleets-ps-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "synthetic installer's script.ps1");
  await fs.writeFile(script, "param([string]$Url,[string]$Ticket,[string]$Name,[string]$Project,[string]$Alias)\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n@{url=$Url;ticket=$Ticket;name=$Name;project=$Project;alias=$Alias;payloadCleared=(-not (Test-Path Env:AGENTFLEETS_NPM_INSTALL_ARGS))} | ConvertTo-Json -Compress\n$global:LASTEXITCODE = 0\n");
  const values = { url: 'https://panel.example', ticket: 'synthetic.ticket', name: "Viewer's 中文 PC", project: 'C:\\my 中文 folder', alias: 'example' };
  const command = installerCommand(context({ platform: 'win32', env: process.env }), values);
  command.env.AGENTFLEETS_NPM_INSTALL_ARGS = JSON.stringify({ script, values });
  const result = await runCommand(command.file, command.args, { env: command.env });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ...values, payloadCleared: true });
});

test('packed package installs globally and runs via npm exec with scripts disabled and isolated cache', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'agentfleets-npm-pack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli?.endsWith('.js'), 'Run package tests with npm test to locate its trusted npm CLI.');
  const env = { ...process.env, npm_config_cache: path.join(dir, 'cache'), npm_config_userconfig: path.join(dir, 'empty-npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npm = async args => execute(process.execPath, [npmCli, ...args], { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024 });
  const packed = JSON.parse((await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', dir])).stdout)[0];
  assert.equal(packed.name, 'agentfleets');
  assert.equal(packed.version, VERSION);
  const fileNames = packed.files.map(file => file.path);
  for (const file of fileNames) assert.match(file, /^(?:package\.json|README\.md|bin\/agentfleets\.mjs|src\/cli\.mjs|dist\/LICENSE|dist\/installers\/(?:install\.sh|install-macos\.sh|install\.ps1|windows-launcher\.cmd))$/);
  for (const required of ['dist/installers/install.sh', 'dist/installers/install-macos.sh', 'dist/installers/install.ps1', 'dist/LICENSE']) assert.ok(fileNames.includes(required));
  const prefix = path.join(dir, 'global prefix');
  const tarball = path.join(dir, packed.filename);
  await npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', tarball]);
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules/agentfleets');
  const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert.equal(pkg.scripts[name], undefined);
  const version = await execute(process.execPath, [path.join(installed, 'bin/agentfleets.mjs'), '--version'], { env });
  assert.equal(version.stdout.trim(), VERSION);
  const help = await npm(['exec', '--offline', '--yes', '--ignore-scripts', `--package=${tarball}`, '--', 'agentfleets', '--help']);
  assert.match(help.stdout, /AgentFleets npm installer/);
  assert.match(help.stdout, /background Agent uses its own runtime/);
  await npm(['uninstall', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', 'agentfleets']);
});
