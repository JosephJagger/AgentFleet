import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAddress, parseSshAccounts, SshAccess } from "../src/ssh-access.js";

async function keyPair(directory: string, passphrase = "") {
  const path = join(directory, `key-${Math.random().toString(36).slice(2)}`);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "test", "-f", path]);
  return { privateKey: await fs.readFile(path, "utf8"), publicKey: (await fs.readFile(`${path}.pub`, "utf8")).trim() };
}

const account = (overrides: Record<string, unknown>) => ({
  id: "ssh_one", alias: "af-qianyi", name: "qianyi", targetName: "Qianyi", username: "deploy", hostname: "10.0.0.8", port: 22,
  passphrase: "", hostKeys: [], description: "构建机", ...overrides,
});

test("sync writes an isolated, pinned config and one Include, then revocation removes everything", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  await fs.mkdir(join(home, ".ssh"), { mode: 0o700 });
  await fs.writeFile(join(home, ".ssh", "config"), "Host personal\n  User me\n", { mode: 0o600 });
  const pair = await keyPair(home);
  const hostKey = (await keyPair(home)).publicKey;
  const ssh = new SshAccess(home, undefined, "linux");
  const accounts = parseSshAccounts([account({ ...pair, hostKeys: [hostKey] })]);

  assert.deepEqual(await ssh.sync(accounts), { accounts: { ssh_one: { ok: true } } });
  await ssh.sync(accounts);
  const userConfig = await fs.readFile(join(home, ".ssh", "config"), "utf8");
  assert.equal(userConfig.match(/^Include /gm)?.length, 1, "Include is idempotent");
  assert.ok(userConfig.startsWith("# AgentFleets managed SSH hosts\nInclude "), "Include precedes Host blocks");
  assert.match(userConfig, /Host personal/);
  const config = await fs.readFile(join(ssh.root, "config"), "utf8");
  assert.match(config, /Host af-qianyi\n  HostName 10\.0\.0\.8\n  Port 22\n  User deploy/);
  assert.match(config, /StrictHostKeyChecking yes/);
  assert.equal((await fs.readFile(join(ssh.root, "known_hosts"), "utf8")).trim(), `af-qianyi ${hostKey.split(" ").slice(0, 2).join(" ")}`);
  assert.equal((await fs.stat(join(ssh.root, "keys", "af-qianyi"))).mode & 0o777, 0o600);
  assert.match(await ssh.instructions() ?? "", /ssh af-qianyi.*|af-qianyi → Qianyi（用户 deploy）：构建机/);

  // A fresh instance recovers the host list from disk for agent instructions.
  assert.match(await new SshAccess(home, undefined, "linux").instructions() ?? "", /af-qianyi/);

  await ssh.sync([]);
  assert.equal(await fs.readFile(join(home, ".ssh", "config"), "utf8"), "Host personal\n  User me\n");
  await assert.rejects(fs.stat(ssh.root));
  assert.equal(await ssh.instructions(), undefined);
});

test("encrypted keys are unlocked with their passphrase; mismatches are reported per account", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const locked = await keyPair(home, "correct horse");
  const other = await keyPair(home);
  const ssh = new SshAccess(home, undefined, "linux");
  const result = await ssh.sync(parseSshAccounts([
    account({ id: "ssh_locked", alias: "af-locked", ...locked, passphrase: "correct horse" }),
    account({ id: "ssh_wrong", alias: "af-wrong", ...locked, passphrase: "wrong" }),
    account({ id: "ssh_mismatch", alias: "af-mismatch", privateKey: other.privateKey, publicKey: locked.publicKey }),
  ]));
  assert.deepEqual(result.accounts.ssh_locked, { ok: true });
  assert.equal(result.accounts.ssh_wrong?.ok, false);
  assert.equal(result.accounts.ssh_mismatch?.error, "私钥与公钥不匹配");
  const config = await fs.readFile(join(ssh.root, "config"), "utf8");
  assert.match(config, /Host af-locked/);
  assert.doesNotMatch(config, /af-wrong|af-mismatch/);
  assert.match(config, /StrictHostKeyChecking accept-new/, "unpinned hosts fall back to trust-on-first-use");
  assert.deepEqual(await fs.readdir(join(ssh.root, "keys")), ["af-locked"]);
});

test("config injection and non-Linux hosts are rejected", async () => {
  const pair = await keyPair(await fs.mkdtemp(join(tmpdir(), "af-ssh-")));
  assert.throws(() => parseSshAccounts([account({ ...pair, hostname: "x\n  ProxyCommand evil" })]), /无效/);
  assert.throws(() => parseSshAccounts([account({ ...pair, alias: "personal" })]), /无效/);
  assert.throws(() => parseSshAccounts([account({ ...pair, username: "a b" })]), /无效/);
  await assert.rejects(new SshAccess("/nonexistent", undefined, "win32").handle({ action: "sync", accounts: [] }), /仅支持 Linux 和 macOS/);
  assert.equal(new SshAccess("/nonexistent", undefined, "darwin").supported, true);
});

test("inspection reports whether the account authorizes the key", async () => {
  const ssh = new SshAccess("/nonexistent", async (command, args) => {
    assert.deepEqual([command, ...args], ["getent", "passwd", "nobody-af"]);
    return { code: 2, stdout: "", stderr: "" };
  }, "linux");
  const pair = await keyPair(await fs.mkdtemp(join(tmpdir(), "af-ssh-")));
  const result = await ssh.inspect("nobody-af", pair.publicKey);
  assert.equal(result.userExists, false);
  assert.equal(result.authorized, null);
  assert.ok(Number.isSafeInteger(result.port));
});

test("concurrent syncs apply in order and leave the latest state", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const pair = await keyPair(home);
  const ssh = new SshAccess(home, undefined, "linux");
  await Promise.all([
    ssh.sync(parseSshAccounts([account({ ...pair, alias: "af-first" })])),
    ssh.sync(parseSshAccounts([account({ ...pair, alias: "af-second" })])),
  ]);
  assert.deepEqual(await fs.readdir(join(ssh.root, "keys")), ["af-second"]);
  assert.match(await fs.readFile(join(ssh.root, "config"), "utf8"), /Host af-second/);
});

test("key passphrases never appear in a child's command line and wrong ones are rejected", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const locked = await keyPair(home, "correct horse");
  const calls: { command: string; args: string[]; env?: Record<string, string> | undefined }[] = [];
  const recording = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    calls.push({ command, args, env });
    execFile(command, args, { timeout: timeoutMs, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  const ssh = new SshAccess(home, recording, "linux");
  const result = await ssh.sync(parseSshAccounts([
    account({ id: "ssh_ok", alias: "af-ok", ...locked, passphrase: "correct horse" }),
    account({ id: "ssh_bad", alias: "af-bad", ...locked, passphrase: "wrong horse" }),
  ]));
  assert.deepEqual(result.accounts.ssh_ok, { ok: true });
  assert.equal(result.accounts.ssh_bad?.ok, false);
  assert.match(result.accounts.ssh_bad?.error ?? "", /口令/);
  for (const call of calls) for (const secret of ["correct horse", "wrong horse"]) assert.ok(!call.args.some(arg => arg.includes(secret)), `${call.command} argv leaks a passphrase`);
  const unlock = calls.filter(call => call.args[0] === "-p");
  assert.equal(unlock.length, 2);
  assert.equal(unlock[0]?.env?.AGENTFLEET_KEY_PASSPHRASE, "correct horse");
  assert.equal(unlock[0]?.env?.SSH_ASKPASS_REQUIRE, "force");
  assert.deepEqual(await fs.readdir(join(ssh.root, "keys")), ["af-ok"]);
  // The helper holds no secret; only an unlocked key remains, and only in the 0600 key file.
  const helper = await fs.readFile(join(ssh.root, "askpass.sh"), "utf8");
  assert.ok(!helper.includes("correct horse") && helper.includes("AGENTFLEET_KEY_PASSPHRASE"));
  assert.equal((await fs.stat(join(ssh.root, "askpass.sh"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(ssh.root, "keys", "af-ok"))).mode & 0o777, 0o600);
});

test("agent instructions state each host's fingerprint status truthfully", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const pair = await keyPair(home);
  const hostKey = (await keyPair(home)).publicKey;
  const ssh = new SshAccess(home, undefined, "linux");
  await ssh.sync(parseSshAccounts([
    account({ id: "ssh_pin", alias: "af-pinned", ...pair, hostKeys: [hostKey] }),
    account({ id: "ssh_free", alias: "af-free", ...pair, hostKeys: [] }),
  ]));
  const text = await new SshAccess(home, undefined, "linux").instructions() ?? "";
  assert.doesNotMatch(text, /指纹已校验/);
  assert.match(text, /af-pinned[^\n]*\[主机指纹已固定\]/);
  assert.match(text, /af-free[^\n]*\[主机指纹未固定/);
  assert.match(await fs.readFile(join(ssh.root, "HOSTS.md"), "utf8"), /af-free[^\n]*未固定/);
  // A state file written by an older agent carries no fingerprint status, so nothing is claimed either way.
  await fs.writeFile(join(ssh.root, "state.json"), JSON.stringify({ hosts: [{ alias: "af-old", targetName: "Old", username: "deploy", description: "" }] }));
  const legacy = await new SshAccess(home, undefined, "linux").instructions() ?? "";
  assert.match(legacy, /af-old/);
  assert.doesNotMatch(legacy, /指纹已固定|指纹未固定|已校验/);
});

test("addresses are classified as LAN, public or overlay networks", () => {
  assert.equal(classifyAddress("eth0", "192.168.1.8"), "lan");
  assert.equal(classifyAddress("eth0", "10.1.2.3"), "lan");
  assert.equal(classifyAddress("eth0", "172.20.0.5"), "lan");
  assert.equal(classifyAddress("eth0", "172.32.0.5"), "public", "172.32/16 is outside RFC 1918");
  assert.equal(classifyAddress("eth0", "203.0.113.9"), "public");
  assert.equal(classifyAddress("eth0", "fd12:3456::1"), "lan");
  assert.equal(classifyAddress("eth0", "2001:db8::1"), "public");
  assert.equal(classifyAddress("tailscale0", "100.101.102.103"), "overlay");
  assert.equal(classifyAddress("eth1", "100.64.0.9"), "overlay", "CGNAT range is Tailscale's");
  assert.equal(classifyAddress("eth1", "100.128.0.9"), "public", "just outside 100.64/10");
  assert.equal(classifyAddress("wg0", "10.8.0.2"), "overlay");
  assert.equal(classifyAddress("ztabcdef", "10.147.17.3"), "overlay");
  assert.equal(classifyAddress("utun4", "100.90.1.1"), "overlay");
  assert.equal(classifyAddress("eth0", "fd7a:115c:a1e0::1"), "overlay");
});

test("macOS inspection uses the directory service, not getent, and reports whether sshd listens", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const pair = await keyPair(home);
  await fs.mkdir(join(home, "user", ".ssh"), { recursive: true });
  await fs.writeFile(join(home, "user", ".ssh", "authorized_keys"), `${pair.publicKey}\n`);
  const commands: string[] = [];
  const run = async (command: string, args: string[]) => {
    commands.push(command);
    if (args.includes("/Users/missing")) return { code: 56, stdout: "", stderr: "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)" };
    return { code: 0, stdout: `NFSHomeDirectory: ${join(home, "user")}\n`, stderr: "" };
  };
  const listening: number[] = [];
  const ssh = new SshAccess("/nonexistent", run, "darwin", async port => { listening.push(port); return false; });
  const found = await ssh.inspect("user", pair.publicKey);
  assert.equal(found.userExists, true);
  assert.equal(found.authorized, true);
  assert.equal(found.listening, false, "Remote Login off is reported rather than guessed");
  assert.deepEqual(listening, [found.port]);
  assert.ok(Object.keys(found.addressKinds).every(address => found.addresses.includes(address)));
  const missing = await ssh.inspect("missing", pair.publicKey);
  assert.equal(missing.userExists, false);
  assert.equal(missing.authorized, null);
  assert.ok(commands.every(command => command === "dscl"), "getent does not exist on macOS");
});

test("jump hosts are configured only through another installed direct account, never as chains", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "af-ssh-"));
  const pair = await keyPair(home);
  const other = await keyPair(home);
  const hostKey = (await keyPair(home)).publicKey;
  const accounts = parseSshAccounts([
    account({ id: "ssh_jump", alias: "af-bastion", targetName: "Bastion", ...pair, hostKeys: [hostKey] }),
    account({ id: "ssh_inner", alias: "af-inner", targetName: "Inner", ...other, hostname: "10.9.0.4", hostKeys: [hostKey], proxyJump: "af-bastion" }),
  ]);
  const ssh = new SshAccess(home, undefined, "linux");
  assert.deepEqual(await ssh.sync(accounts), { accounts: { ssh_jump: { ok: true }, ssh_inner: { ok: true } } });
  const config = await fs.readFile(join(ssh.root, "config"), "utf8");
  assert.match(config, /Host af-inner\n(?:.*\n)*?\s+ProxyJump af-bastion\n/);
  assert.doesNotMatch(config.split("Host af-inner")[0]!, /ProxyJump/, "the jump host itself is direct");
  assert.match(await ssh.instructions() ?? "", /af-inner[^\n]*\[经 af-bastion 跳转\]/);
  assert.match(await fs.readFile(join(ssh.root, "HOSTS.md"), "utf8"), /af-inner[^\n]*经 af-bastion 跳转/);

  // A jump whose key cannot be installed takes its dependants with it instead of silently connecting directly.
  const broken = parseSshAccounts([
    account({ id: "ssh_jump", alias: "af-bastion", ...pair, privateKey: other.privateKey }),
    account({ id: "ssh_inner", alias: "af-inner", ...other, proxyJump: "af-bastion" }),
  ]);
  const result = await new SshAccess(await fs.mkdtemp(join(tmpdir(), "af-ssh-")), undefined, "linux").sync(broken);
  assert.equal(result.accounts.ssh_jump?.ok, false);
  assert.deepEqual(result.accounts.ssh_inner, { ok: false, error: "跳板机账号未能安装" });

  for (const bad of [
    [account({ id: "ssh_a", alias: "af-a", ...pair, proxyJump: "af-missing" })],
    [account({ id: "ssh_a", alias: "af-a", ...pair, proxyJump: "af-a" })],
    [account({ id: "ssh_a", alias: "af-a", ...pair, proxyJump: "af-b" }), account({ id: "ssh_b", alias: "af-b", ...pair, proxyJump: "af-a" })],
    [account({ id: "ssh_a", alias: "af-a", ...pair, proxyJump: "x\n  ProxyCommand evil" })],
  ]) assert.throws(() => parseSshAccounts(bad), /无效/);
});
