import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
export const VERSION = metadata.version;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const OPTIONS = ['url', 'ticket', 'name', 'project', 'alias'];
const HELP = `AgentFleets npm installer ${VERSION}

Usage:
  agentfleets connect --url <https://panel> [--ticket <ticket>] [--name <name>] [--project <path>] [--alias <alias>]
  agentfleets status
  agentfleets --help
  agentfleets --version

Requires Node.js 22+ and supports Linux x64, macOS x64/arm64 and Windows x64.
Connect without a ticket uses the native browser confirmation flow.
An existing installation is left unchanged; manage updates/repair in the panel.
The background Agent uses its own runtime, not this npm installation.
Uninstalling/updating this npm package does not uninstall/update the Agent.
`;

class CliError extends Error {}
const invalid = (message) => { throw new CliError(message); };

export function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) return { command: 'help' };
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return { command: 'version' };
  const [command, ...rest] = argv;
  if (!['connect', 'status'].includes(command)) invalid('Unknown command. Run agentfleets --help.');
  if (rest.length === 1 && rest[0] === '--help') return { command: 'help' };
  const values = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    const match = /^--([a-z]+)(?:=(.*))?$/s.exec(token);
    if (command !== 'connect' || !match || !OPTIONS.includes(match[1])) invalid('Unsupported argument. Run agentfleets --help.');
    const key = match[1];
    if (Object.hasOwn(values, key)) invalid(`--${key} must not be repeated.`);
    const value = match[2] ?? rest[++index];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) invalid(`--${key} requires a non-empty value without control characters.`);
    values[key] = value;
  }
  if (command === 'connect') {
    if (!values.url) invalid('--url is required. Copy the command from Add Host in your panel.');
    let url;
    try { url = new URL(values.url); } catch { invalid('--url must be a valid HTTPS panel address.'); }
    if (url.username || url.password || url.search || url.hash || /[?#@\\\s]/.test(values.url)) invalid('--url must not contain credentials, queries, fragments or whitespace.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) invalid('--url must use HTTPS (HTTP is allowed only for localhost or 127.0.0.1).');
    values.url = url.href.replace(/\/$/, '');
  }
  return { command, values };
}

export function layoutFor(context) {
  const { platform, arch, env, uid } = context;
  if (!['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].includes(`${platform}-${arch}`)) invalid('Unsupported platform. Supported: Linux x64, macOS x64/arm64, Windows x64.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'linux' && uid === 0;
  const home = root ? '/root' : platform === 'win32' ? context.home : env.HOME || context.home;
  const dataBase = platform === 'win32' ? env.LOCALAPPDATA : root ? '/root/.local/share' : env.XDG_DATA_HOME || paths.join(home, '.local/share');
  for (const value of [home, dataBase]) {
    if (!value || !paths.isAbsolute(value) || /(^|[\\/])\.{1,2}([\\/]|$)/.test(value) || paths.parse(value).root === value) invalid('Installation paths must be absolute, non-root directories without dot components.');
  }
  const dataRoot = platform === 'win32' ? paths.join(dataBase, 'AgentFleet') : platform === 'darwin' ? paths.join(home, 'Library/Application Support/AgentFleet') : paths.join(dataBase, 'agentfleet');
  if (env.AGENTFLEET_HOME && paths.resolve(env.AGENTFLEET_HOME) !== dataRoot && !root) invalid('A custom AGENTFLEET_HOME is configured. Use the panel native installation/repair instructions for this installation.');
  const binRoot = platform === 'darwin' ? paths.join(home, '.local/share/agentfleet/bin') : paths.join(dataRoot, 'bin');
  const launcher = platform === 'win32' ? paths.join(dataRoot, 'agentfleet.cmd') : paths.join(home, '.local/bin/agentfleet');
  const service = platform === 'linux' ? root ? '/etc/systemd/system/agentfleet.service' : paths.join(env.XDG_CONFIG_HOME || paths.join(home, '.config'), 'systemd/user/agentfleet.service') : platform === 'darwin' ? uid === 0 ? '/Library/LaunchDaemons/cn.agentfleets.agent.plist' : paths.join(home, 'Library/LaunchAgents/cn.agentfleets.agent.plist') : paths.join(dataRoot, 'agentfleet-service.cmd');
  return { paths, platform, dataRoot, binRoot, launcher, service, pointer: platform === 'win32' ? paths.join(binRoot, 'current.txt') : undefined, previous: platform === 'win32' ? paths.join(binRoot, 'previous.txt') : paths.join(home, '.local/bin/agentfleet.previous') };
}

async function statIfPresent(file, io) {
  try { return await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function regular(file, io, executable = false) {
  const stat = await statIfPresent(file, io);
  if (!stat?.isFile() || stat.isSymbolicLink() || (executable && !(stat.mode & 0o111))) return false;
  return true;
}

function samePath(first, second, platform) {
  return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

// Read only directory/launcher metadata, never native state databases or credentials.
export async function inspectInstallation(layout, io = fs) {
  const { paths, dataRoot, binRoot, launcher, platform } = layout;
  const conflict = { kind: 'conflict' };
  for (const dir of [dataRoot, binRoot, paths.dirname(launcher)]) {
    const stat = await statIfPresent(dir, io);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (platform !== 'win32' && (stat.mode & 0o022)) || !samePath(await io.realpath(dir), paths.resolve(dir), platform))) return conflict;
  }
  const launchStat = await statIfPresent(launcher, io);
  if (!launchStat) {
    for (const file of [layout.pointer, layout.previous, layout.service, ...['state.sqlite', 'state.json', 'machine-ed25519.pem', 'runtime-profile.json'].map(name => paths.join(dataRoot, name))].filter(Boolean)) {
      if (await statIfPresent(file, io)) return conflict;
    }
    return { kind: 'absent' };
  }
  if (platform === 'win32') {
    if (!await regular(launcher, io) || !await regular(layout.pointer, io)) return conflict;
    const version = (await io.readFile(layout.pointer, 'utf8')).trim();
    if (!SEMVER.test(version)) return conflict;
    const stable = '@echo off\nsetlocal\nset /p AGENTFLEET_CURRENT=<"%~dp0bin\\current.txt"\ncall "%~dp0bin\\%AGENTFLEET_CURRENT%\\agentfleet.cmd" %*\nexit /b %errorlevel%\n';
    if ((await io.readFile(launcher, 'utf8')).replaceAll('\r\n', '\n') !== stable) return conflict;
    const target = paths.join(binRoot, version);
    for (const dir of [target, paths.join(target, 'runtime'), paths.join(target, 'lib/dist/src')]) {
      if (!samePath(await io.realpath(dir), paths.resolve(dir), platform)) return conflict;
    }
    const nativeLauncher = paths.join(target, 'agentfleet.cmd');
    const expected = (await fs.readFile(path.join(packageRoot, 'dist/installers/windows-launcher.cmd'), 'utf8')).replaceAll('\r\n', '\n');
    if (!await regular(nativeLauncher, io) || (await io.readFile(nativeLauncher, 'utf8')).replaceAll('\r\n', '\n') !== expected) return conflict;
    const runtime = paths.join(target, 'runtime/node.exe');
    const cli = paths.join(target, 'lib/dist/src/cli.js');
    if (!await regular(runtime, io) || !await regular(cli, io)) return conflict;
    // Avoid cmd.exe argument expansion entirely for read-only queries.
    return { kind: 'installed', version, file: runtime, prefix: [cli] };
  }
  if (!launchStat.isSymbolicLink()) return conflict;
  let target;
  try { target = await io.realpath(launcher); } catch (error) { if (error.code === 'ENOENT') return conflict; throw error; }
  const relative = paths.relative(binRoot, target).split(paths.sep);
  if (relative.length !== 2 || !SEMVER.test(relative[0]) || relative[1] !== 'agentfleet') return conflict;
  if (!await regular(target, io, true)) return conflict;
  if ((await io.lstat(target)).mode & 0o022) return conflict;
  if (platform === 'linux') {
    const marker = paths.join(binRoot, '.managed-by-agentfleet');
    if (!await regular(marker, io) || (await io.readFile(marker, 'utf8')).split('\n')[0] !== 'agentfleet-binaries-v1') return conflict;
  }
  return { kind: 'installed', version: relative[0], file: target, prefix: [] };
}

export function installerCommand(context, values) {
  const env = { ...context.env, AGENTFLEET_NPM_FRESH_INSTALL: '1' };
  if (context.platform !== 'win32') {
    const file = path.join(packageRoot, 'dist/installers', context.platform === 'darwin' ? 'install-macos.sh' : 'install.sh');
    return { file: '/bin/sh', args: [file, ...OPTIONS.filter(key => values[key] !== undefined).flatMap(key => [`--${key}`, values[key]])], env };
  }
  // The native installer still hands arguments to its bundled .cmd launcher.
  // Reject characters cmd.exe can expand/reparse, even though the PowerShell
  // invocation below is data-only. Spaces, Unicode and apostrophes are supported.
  const cwd = context.cwd ?? process.cwd();
  const effectiveValues = { ...values, project: values.project ?? cwd, name: values.name ?? context.hostname ?? hostname() };
  const installer = path.join(packageRoot, 'dist/installers/install.ps1');
  if ([...Object.values(effectiveValues), context.env.LOCALAPPDATA || '', installer, cwd].some(value => /[%!&|<>^"()\x00-\x1f\x7f]/.test(value))) invalid('Windows installation arguments, current/package directories and LOCALAPPDATA cannot contain control characters, %, !, &, |, <, >, ^, quotes or parentheses because the native launcher uses cmd.exe. Use a simple project path and name, then add other projects in the panel.');
  const powershell = path.win32.join(context.env.SystemRoot || context.env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // All untrusted values travel as JSON in the child environment, never as PS code.
  env.AGENTFLEETS_NPM_INSTALL_ARGS = JSON.stringify({ script: installer, values: effectiveValues });
  const source = `$ErrorActionPreference = 'Stop'
$request = $env:AGENTFLEETS_NPM_INSTALL_ARGS | ConvertFrom-Json
Remove-Item Env:AGENTFLEETS_NPM_INSTALL_ARGS
$parameters = @{}
foreach ($property in $request.values.PSObject.Properties) { $parameters[$property.Name] = [string]$property.Value }
try { & $request.script @parameters; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine('Native installer failed. Review installation prerequisites and retry; existing service state was preserved.'); exit 1 }
`;
  return { file: powershell, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], env };
}

function cleanOutput(text, secrets) {
  let value = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, '[redacted]');
  return value;
}

export async function runCommand(file, args, options = {}) {
  const { env = process.env, interactive = false, output = () => {}, secrets = [] } = options;
  return new Promise(resolve => {
    let stdout = '';
    let oversized = false;
    let settled = false;
    let child;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    try { child = spawn(file, args, { shell: false, env, windowsHide: true, stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'] }); }
    catch { finish({ code: 1, stdout: '' }); return; }
    for (const [stream, errorStream] of [[child.stdout, false], [child.stderr, true]]) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      stream.on('data', chunk => {
        const value = decoder.write(chunk);
        if (!interactive) {
          if (!errorStream) stdout += value;
          if (stdout.length > 65536) { oversized = true; child.kill(); }
          return;
        }
        pending += value;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          output(cleanOutput(pending.slice(0, newline + 1), secrets), errorStream);
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 65536) { pending = ''; output('[Installer output line omitted: too long]\n', errorStream); }
      });
      stream.on('end', () => { if (interactive) output(cleanOutput(pending + decoder.end(), secrets), errorStream); });
    }
    const timeout = interactive ? undefined : setTimeout(() => { child.kill(); }, 20000);
    child.on('error', () => { clearTimeout(timeout); finish({ code: 1, stdout: '' }); });
    child.on('close', code => { clearTimeout(timeout); finish({ code: oversized ? 1 : code ?? 1, stdout }); });
  });
}

async function reportStatus(installation, context) {
  context.out(`npm installer: ${VERSION}\n`);
  if (installation.kind === 'absent') { context.out('Agent: not installed for this operating-system account.\n'); return; }
  if (installation.kind !== 'installed') invalid('An existing or incomplete Agent installation could not be verified. Nothing was changed. Use the panel native repair/pairing instructions; do not delete its data.');
  const version = await context.run(installation.file, [...installation.prefix, '--version'], { env: context.env });
  if (version.code !== 0 || version.stdout.trim() !== installation.version) invalid('The managed Agent version could not be verified. Nothing was changed. Use the panel repair instructions.');
  context.out(`Agent: ${installation.version}\n`);
  const status = await context.run(installation.file, [...installation.prefix, 'service', 'status', '--json'], { env: context.env });
  let result;
  try { result = JSON.parse(status.stdout); } catch { /* Report a bounded, non-sensitive error below. */ }
  if (status.code !== 0 || !result || typeof result.installed !== 'boolean' || typeof result.active !== 'boolean') invalid('Service status is unavailable. Nothing was changed. Check the host in the panel.');
  context.out(`Service: ${result.installed ? 'installed' : 'not installed'}; ${result.active ? 'running' : 'not running'}.\nPanel connectivity: confirm in the panel (service status alone does not prove an online connection).\n`);
}

export async function main(argv, overrides = {}) {
  const context = { platform: process.platform, arch: process.arch, env: process.env, home: homedir(), uid: process.getuid?.(), run: runCommand, io: fs, out: text => process.stdout.write(text), err: text => process.stderr.write(text), ...overrides };
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) invalid('Node.js 22 or newer is required for the npm installer.');
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') { context.out(HELP); return 0; }
    if (parsed.command === 'version') { context.out(`${VERSION}\n`); return 0; }
    const layout = layoutFor(context);
    const installation = await inspectInstallation(layout, context.io);
    if (parsed.command === 'status') { await reportStatus(installation, context); return 0; }
    if (installation.kind !== 'absent') {
      await reportStatus(installation, context);
      context.out('Existing installation kept unchanged. This connect command did not use the ticket, re-pair, restart or update the Agent. Manage this host in the panel; use native pairing/repair instructions if onboarding was incomplete.\n');
      return 0;
    }
    const command = installerCommand(context, parsed.values);
    const resource = path.join(packageRoot, 'dist/installers', context.platform === 'win32' ? 'install.ps1' : context.platform === 'darwin' ? 'install-macos.sh' : 'install.sh');
    if (!await regular(resource, fs)) invalid('Bundled installer is missing. Reinstall the published npm package; source checkouts require npm run build.');
    context.out('Installing the native Agent. Keep Add Host open until the panel confirms this host is online.\n');
    const result = await context.run(command.file, command.args, { env: command.env, interactive: true, secrets: [parsed.values.ticket], output: (text, error) => error ? context.err(text) : context.out(text) });
    if (result.code !== 0) invalid('Native installation did not finish. Before retrying, run agentfleets status. If an installation is detected, use panel pairing/repair instructions; existing data is preserved.');
    context.out('Native installer finished. Confirm the host appears online in the panel. Future Agent upgrades are managed by the panel.\n');
    return 0;
  } catch (error) {
    context.err(`agentfleets: ${error instanceof CliError ? error.message : 'Unable to verify installation or run the installer. Nothing was overwritten by the npm wrapper; check directory permissions and native installation status.'}\n`);
    return 1;
  }
}
