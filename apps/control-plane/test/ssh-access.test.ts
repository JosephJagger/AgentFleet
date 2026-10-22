import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/auth.js";
import { parseInspection, parseSshPrivateKey, parseSshPublicKey, SshAccessBroker, SshAccessService } from "../src/ssh-access.js";
import { tmpdir as osTmp } from "node:os";

function keyPair(passphrase = "", type = "ed25519", format?: string) {
  const root = mkdtempSync(join(tmpdir(), "cp-ssh-"));
  const path = join(root, "key");
  try {
    execFileSync("ssh-keygen", ["-q", "-t", type, ...(format ? ["-m", format] : []), "-N", passphrase, "-C", "test", "-f", path]);
    return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function fixture() {
  const db = new ControlPlaneDatabase(":memory:");
  const { workspaceId, userId } = db.bootstrap(loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "ssh@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: ":memory:", PUBLIC_ORIGIN: "http://ssh.test", COOKIE_SECURE: "false" }));
  const at = new Date().toISOString();
  for (const [machine, platform] of [["a", "linux"], ["b", "linux"], ["c", "linux"], ["mac", "darwin"], ["win", "win32"]] as const) {
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at) VALUES(?,?,?,?,?,?,'24','x64','0.30.0','active','normal','online','compatible','idle',?,?)`, machine, workspaceId, `key-${machine}`, `fingerprint-${machine}`, machine, platform, at, at);
  }
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('csess_test',?,?,'token','csrf',?,?,?)", workspaceId, userId, at, at, at);
  const principal = { userId, workspaceId, clientSessionId: "csess_test", email: "ssh@example.test", csrfHash: "", expiresAt: at } as Principal;
  return { db, principal, service: new SshAccessService(db, ":memory:") };
}

test("key parsing derives and checks the public key without decrypting", () => {
  const pair = keyPair("secret");
  const parsed = parseSshPrivateKey(pair.privateKey);
  assert.equal(parsed.encrypted, true);
  assert.ok(parsed.publicBlob?.equals(parseSshPublicKey(pair.publicKey).blob));
  assert.match(parseSshPublicKey(pair.publicKey).fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.throws(() => parseSshPublicKey("ssh-ed25519 not-base64!"), /公钥格式无效/);
  assert.throws(() => parseSshPrivateKey("hello"), /私钥格式无效/);
});

test("accounts are encrypted at rest, never echoed, and validated against their key", () => {
  const { db, principal, service } = fixture();
  const pair = keyPair();
  const saved = service.save(principal, { machineId: "a", name: "qianyi", algorithm: "ed25519", username: "deploy", address: "10.0.0.8", privateKey: pair.privateKey, publicKey: "", description: "构建机" });
  assert.equal(saved.publicKey, parseSshPublicKey(pair.publicKey).line, "public key is derived from an OpenSSH private key");
  assert.equal(saved.alias, "af-qianyi");
  assert.equal(JSON.stringify(saved).includes("PRIVATE KEY"), false);
  const stored = db.get<{ encrypted_private_key: string }>("SELECT encrypted_private_key FROM host_ssh_accounts")!;
  assert.equal(stored.encrypted_private_key.includes("PRIVATE KEY"), false);
  assert.ok(db.get("SELECT 1 AS found FROM audit_entries WHERE action='ssh.account.create'"));

  const other = keyPair();
  assert.throws(() => service.save(principal, { machineId: "b", name: "x", algorithm: "ed25519", username: "u", privateKey: other.privateKey, publicKey: pair.publicKey }), /不匹配/);
  assert.throws(() => service.save(principal, { machineId: "b", name: "x", algorithm: "rsa", username: "u", ...other }), /不一致/);
  assert.throws(() => service.save(principal, { machineId: "b", name: "x", algorithm: "ed25519", username: "u", ...keyPair("pw") }), /口令/);
  assert.throws(() => service.save(principal, { machineId: "win", name: "x", algorithm: "ed25519", username: "u", ...other }), /仅支持 Linux 和 macOS/);
  assert.throws(() => service.save(principal, { machineId: "b", name: "QIANYI", algorithm: "ed25519", username: "u", ...other }), /已被使用/);

  // Editing without re-entering the private key keeps it.
  const edited = service.save(principal, { name: "qianyi", algorithm: "ed25519", username: "deploy", address: "10.0.0.9", description: "" }, saved.id);
  assert.equal(edited.address, "10.0.0.9");
  assert.equal(service.desired("b")[0]?.privateKey, `${pair.privateKey.trim()}\n`);
});

test("desired state covers other Linux hosts in scope and pins reported host keys", () => {
  const { principal, service } = fixture();
  const pair = keyPair("pw");
  const saved = service.save(principal, { machineId: "a", name: "qianyi", algorithm: "ed25519", username: "deploy", ...pair, passphrase: "pw" });
  assert.deepEqual(service.desired("b"), [], "without an address the account is not distributable yet");
  const hostKey = keyPair().publicKey;
  service.recordInspection(saved.id, parseInspection({ userExists: true, authorized: true, hostKeys: [hostKey, "garbage"], addresses: ["192.168.1.5", "bad address!"], port: 22 }));
  const desired = service.desired("b");
  assert.equal(desired[0]?.hostname, "192.168.1.5");
  assert.equal(desired[0]?.passphrase, "pw");
  assert.deepEqual(desired[0]?.hostKeys, [parseSshPublicKey(hostKey).line]);
  assert.deepEqual(service.desired("a"), [], "a host does not receive its own account");
  assert.equal(service.desired("mac").length, 1, "macOS hosts receive accounts like Linux hosts");
  assert.deepEqual(service.desired("win"), [], "Windows hosts receive nothing");
  assert.equal(service.get(principal, saved.id).verification.authorized, true);

  service.save(principal, { name: "qianyi", algorithm: "ed25519", username: "deploy", sources: ["c"] }, saved.id);
  assert.deepEqual(service.desired("b"), []);
  assert.equal(service.desired("c").length, 1);
  assert.deepEqual(service.reachable(principal, "c").map(account => [account.alias, "privateKey" in account, "passphrase" in account]), [["af-qianyi", false, false]]);

  service.remove(principal, saved.id);
  assert.deepEqual(service.desired("c"), []);
});

test("broker only accepts replies from the socket it asked", async () => {
  const sent: Record<string, unknown>[] = [];
  const socket = {};
  const broker = new SshAccessBroker(() => ({ key: socket, ready: true, supported: true, send: value => { sent.push(value); return true; } }));
  const pending = broker.request("a", { action: "test", alias: "af-x" });
  const requestId = sent[0]!.requestId as string;
  broker.receive("a", {}, { requestId, result: "forged" });
  broker.receive("b", socket, { requestId, result: "forged" });
  broker.receive("a", socket, { requestId, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  const failed = broker.request("a", { action: "test" });
  broker.receive("a", socket, { requestId: sent[1]!.requestId, error: { code: "SSH_KEY_MISMATCH", message: "私钥与公钥不匹配" } });
  await assert.rejects(failed, /不匹配/);
  const offline = new SshAccessBroker(() => ({ key: socket, ready: true, supported: false, send: () => true }));
  await assert.rejects(offline.request("a", {}), /更新主机连接服务/);
});

test("minimal input derives a stable host alias; collisions get a suffix without changing existing aliases", () => {
  const { db, principal, service } = fixture();
  try {
    db.run("UPDATE machines SET display_alias='B52H' WHERE machine_id IN ('a','b')");
    db.run("UPDATE machines SET name='srv-chinese',display_alias='主机' WHERE machine_id='c'");
    const { privateKey } = keyPair();
    const first = service.save(principal, { machineId: "a", username: "deploy", privateKey });
    assert.equal(first.alias, "af-b52h"); assert.equal(first.algorithm, "ed25519"); assert.equal(first.port, 22);
    assert.equal(service.save(principal, { machineId: "b", username: "ops", privateKey }).alias, "af-b52h-2");
    assert.equal(service.save(principal, { machineId: "a", username: "other", privateKey }).alias, "af-b52h-3");
    assert.equal(service.save(principal, { machineId: "c", username: "ops", privateKey }).alias, "af-srv-chinese");
    db.run("UPDATE machines SET display_alias='Renamed' WHERE machine_id='a'");
    const edited = service.save(principal, { username: "deploy" }, first.id);
    assert.equal(edited.alias, "af-b52h"); assert.equal(edited.publicKey, first.publicKey);
    const replacement = keyPair("", "ecdsa");
    const rotated = service.save(principal, { username: "deploy", privateKey: replacement.privateKey }, first.id);
    assert.equal(rotated.algorithm, "ecdsa"); assert.equal(rotated.publicKey, parseSshPublicKey(replacement.publicKey).line);
  } finally { db.close(); }
});

for (const [type, format, passphrase] of [
  ["rsa", "", ""], ["ecdsa", "", ""], ["ed25519", "", "secret"],
  ["rsa", "PEM", ""], ["rsa", "PEM", "secret"], ["ecdsa", "PEM", ""], ["ecdsa", "PEM", "secret"], ["rsa", "PKCS8", "secret"],
]) test(`public key and type are derived from ${type} ${format || "OpenSSH"} (encrypted=${Boolean(passphrase)})`, () => {
  const { db, principal, service } = fixture();
  try {
    const pair = keyPair(passphrase, type, format || undefined);
    const saved = service.save(principal, { machineId: "a", username: "deploy", privateKey: pair.privateKey, passphrase });
    assert.equal(saved.algorithm, type); assert.equal(saved.publicKey, parseSshPublicKey(pair.publicKey).line);
    if (format && passphrase) assert.throws(() => service.save(principal, { machineId: "b", username: "deploy", privateKey: pair.privateKey, passphrase: "wrong" }), /私钥/);
  } finally { db.close(); }
});

function addAccount(f: ReturnType<typeof fixture>, machineId: string, name: string, extra: Record<string, unknown> = {}, address = "192.168.1.5") {
  const saved = f.service.save(f.principal, { machineId, name, algorithm: "ed25519", username: "deploy", ...keyPair(), ...extra });
  f.service.recordInspection(saved.id, parseInspection({ userExists: true, authorized: true, hostKeys: [keyPair().publicKey], addresses: [address], port: 22 }));
  return saved;
}

test("macOS hosts can be targets and sources of SSH accounts", () => {
  const f = fixture();
  const onMac = addAccount(f, "mac", "macbook", {}, "192.168.1.30");
  assert.equal(onMac.machineId, "mac");
  assert.equal(f.service.desired("a")[0]?.hostname, "192.168.1.30");
  assert.deepEqual(f.service.desired("win"), [], "Windows is neither a source nor a target");
  assert.throws(() => f.service.save(f.principal, { machineId: "win", name: "w", algorithm: "ed25519", username: "u", ...keyPair() }), /仅支持 Linux 和 macOS/);
  assert.throws(() => f.service.save(f.principal, { machineId: "a", name: "x", algorithm: "ed25519", username: "u", ...keyPair(), sources: ["win"] }), /仅支持 Linux 和 macOS/);
});

test("inspection keeps only known address kinds and whether sshd listens", () => {
  const parsed = parseInspection({ userExists: true, authorized: true, hostKeys: [], addresses: ["10.0.0.4", "100.101.1.1", "203.0.113.5", "bad addr!"], addressKinds: { "10.0.0.4": "lan", "100.101.1.1": "overlay", "203.0.113.5": "weird", "bad addr!": "lan", "9.9.9.9": "public" }, port: 22, listening: false });
  assert.deepEqual(parsed.addressKinds, { "10.0.0.4": "lan", "100.101.1.1": "overlay" }, "unknown kinds and addresses that were filtered out are dropped");
  assert.equal(parsed.listening, false);
  assert.equal(parseInspection({ addresses: [], port: 22 }).listening, null, "an older host that does not report it is unknown, not off");
  assert.equal("addressKinds" in parseInspection({ addresses: ["10.0.0.4"], port: 22 }), false);
});

test("jump routes need a direct account on the jump host and never form chains", () => {
  const f = fixture();
  const inner = { machineId: "a", name: "inner", route: "proxyjump", proxyJumpMachineId: "b" };
  assert.throws(() => addAccount(f, "a", "inner", { route: "tunnel" }), /暂不支持该路由方式/);
  assert.throws(() => addAccount(f, "a", "inner", { route: "relay" }), /请先启用面板中转/, "the panel relay is a workspace switch, off by default");
  assert.throws(() => addAccount(f, "a", "inner", { route: "auto" }), /请先启用面板中转/);
  assert.throws(() => addAccount(f, "a", "inner", { route: "proxyjump" }), /请选择跳板机/);
  assert.throws(() => addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "a" }), /不能是目标主机自身/);
  assert.throws(() => addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "win" }), /仅支持 Linux 和 macOS/);
  assert.throws(() => addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "b" }), /跳板机需要先登记一个直连的 SSH 账号/);
  void inner;

  addAccount(f, "b", "bastion", {}, "203.0.113.7");
  const saved = addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "b" }, "10.9.0.4");
  assert.equal(saved.route, "proxyjump");
  assert.equal(saved.proxyJumpMachineId, "b");
  // The bastion cannot itself hop, because inner hops through it.
  const bastion = f.service.list(f.principal, "b")[0]!;
  addAccount(f, "c", "other-direct");
  assert.throws(() => f.service.save(f.principal, { name: "bastion", algorithm: "ed25519", username: "deploy", route: "proxyjump", proxyJumpMachineId: "c" }, bastion.id), /不能再经跳板连接/);
  assert.throws(() => addAccount(f, "c", "chained", { route: "proxyjump", proxyJumpMachineId: "a" }), /跳板机需要先登记一个直连的 SSH 账号/, "a hopping account is not a valid jump");
});

test("sources only get a jump account when they can honour it; the jump host itself connects directly", () => {
  const f = fixture();
  addAccount(f, "b", "bastion", {}, "203.0.113.7");
  addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "b" }, "10.9.0.4");

  const forC = f.service.desired("c", false);
  assert.deepEqual(forC.map(account => [account.alias, account.proxyJump ?? null]).sort(), [["af-bastion", null], ["af-inner", "af-bastion"]]);
  assert.deepEqual(f.service.desired("b", false).map(account => [account.alias, account.proxyJump ?? null]), [["af-inner", null]], "from the bastion itself the target is reached directly");
  assert.deepEqual(f.service.desired("c", false, { routes: false }).map(account => account.alias), ["af-bastion"], "an agent without jump support is not given an account it would try directly");

  // Scope and state changes of the jump account withhold the dependants instead of silently going direct.
  const bastion = f.service.list(f.principal, "b")[0]!;
  f.service.save(f.principal, { name: "bastion", algorithm: "ed25519", username: "deploy", sources: ["mac"] }, bastion.id);
  assert.deepEqual(f.service.desired("c", false).map(account => account.alias), [], "the jump account is not available to c, so neither is the hop");
  assert.deepEqual(f.service.desired("mac", false).map(account => account.alias).sort(), ["af-bastion", "af-inner"]);
  f.service.save(f.principal, { name: "bastion", algorithm: "ed25519", username: "deploy", sources: [], enabled: false }, bastion.id);
  assert.deepEqual(f.service.desired("c", false).map(account => account.alias), [], "a disabled jump withholds the hop");
});

test("the matrix reports each source's real state and why a link is absent", () => {
  const f = fixture();
  const bastion = addAccount(f, "b", "bastion", {}, "203.0.113.7");
  const inner = addAccount(f, "a", "inner", { route: "proxyjump", proxyJumpMachineId: "b" }, "10.9.0.4");
  const caps = (state: Record<string, { connected: boolean; ssh: boolean; routes: boolean; relay?: boolean }>) => (id: string) => ({ relay: true, ...(state[id] ?? { connected: true, ssh: true, routes: true }) });
  const link = (matrix: ReturnType<typeof f.service.matrix>, accountId: string, source: string) => matrix.links.find(item => item.accountId === accountId)!.sources.find(item => item.machineId === source)!;

  let matrix = f.service.matrix(f.principal, caps({}));
  assert.deepEqual(matrix.hosts.map(host => [host.machineId, host.supported]), [["a", true], ["b", true], ["c", true], ["mac", true], ["win", false]]);
  assert.equal(link(matrix, inner.id, "c").state, "untested");
  assert.equal(link(matrix, inner.id, "c").via, "af-bastion");
  assert.equal(link(matrix, inner.id, "win").state, "unsupported");
  assert.equal(link(matrix, inner.id, "win").reason, "source_platform");
  assert.equal(link(matrix, inner.id, "b").state, "untested", "the bastion reaches the target directly");
  assert.equal(link(matrix, inner.id, "b").via, undefined);
  assert.equal(matrix.links.find(item => item.accountId === inner.id)!.sources.some(item => item.machineId === "a"), false, "no row for the target itself");

  f.service.recordTest(inner.id, "c", { ok: true, durationMs: 120 }, "proxyjump");
  f.service.recordTest(bastion.id, "c", { ok: false, error: "Connection timed out" }, "direct");
  matrix = f.service.matrix(f.principal, caps({}));
  assert.deepEqual([link(matrix, inner.id, "c").state, link(matrix, inner.id, "c").path, link(matrix, inner.id, "c").durationMs], ["ok", "proxyjump", 120]);
  assert.deepEqual([link(matrix, bastion.id, "c").state, link(matrix, bastion.id, "c").error], ["failed", "Connection timed out"]);

  // An older agent cannot be given a hop; an offline one is simply untested; an agent without SSH support cannot take part at all.
  matrix = f.service.matrix(f.principal, caps({ c: { connected: true, ssh: true, routes: false }, mac: { connected: false, ssh: false, routes: false }, b: { connected: true, ssh: false, routes: false } }));
  assert.deepEqual([link(matrix, inner.id, "c").state, link(matrix, inner.id, "c").reason], ["excluded", "routes_unsupported"]);
  assert.deepEqual([link(matrix, inner.id, "mac").state, link(matrix, inner.id, "mac").agent], ["untested", "offline"]);
  assert.deepEqual([link(matrix, inner.id, "b").state, link(matrix, inner.id, "b").reason], ["unsupported", "agent_outdated"]);

  // Changing the path or the target invalidates test evidence about the old one; unrelated edits keep it.
  f.service.save(f.principal, { name: "inner", algorithm: "ed25519", username: "deploy", description: "note" }, inner.id);
  assert.equal(link(f.service.matrix(f.principal, caps({})), inner.id, "c").state, "ok");
  f.service.save(f.principal, { name: "inner", algorithm: "ed25519", username: "deploy", address: "10.9.0.5" }, inner.id);
  assert.equal(link(f.service.matrix(f.principal, caps({})), inner.id, "c").state, "untested");
  f.service.recordTest(inner.id, "c", { ok: true }, "proxyjump");
  f.service.save(f.principal, { name: "inner", algorithm: "ed25519", username: "deploy", route: "direct" }, inner.id);
  assert.equal(link(f.service.matrix(f.principal, caps({})), inner.id, "c").state, "untested", "switching route drops the old evidence");
});

test("upgrading a version 68 database adds routes and test results without touching accounts", () => {
  const root = mkdtempSync(join(osTmp(), "cp-mig-"));
  const path = join(root, "control-plane.sqlite");
  try {
    let db = new ControlPlaneDatabase(path);
    const { workspaceId } = db.bootstrap(loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "mig@example.test", ADMIN_PASSWORD: randomUUID(), DATABASE_PATH: path, PUBLIC_ORIGIN: "http://mig.test", COOKIE_SECURE: "false" }));
    const at = new Date().toISOString();
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at)
      VALUES('m1',?,'k','f','m1','linux','24','x64','0.30.0','active','normal','online','compatible','idle',?,?)`, workspaceId, at, at);
    db.sqlite.exec("DROP TABLE host_ssh_link_tests; ALTER TABLE host_ssh_accounts DROP COLUMN route; ALTER TABLE host_ssh_accounts DROP COLUMN proxy_jump_machine_id; PRAGMA user_version=68");
    db.run(`INSERT INTO host_ssh_accounts(account_id,workspace_id,machine_id,name,algorithm,username,public_key,fingerprint,encrypted_private_key,created_at,updated_at)
      VALUES('ssh_old',?,'m1','legacy','ed25519','deploy','pk','fp','secret',?,?)`, workspaceId, at, at);
    db.close();
    for (const round of [1, 2]) {
      db = new ControlPlaneDatabase(path);
      assert.equal(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version, 70, `round ${round}`);
      assert.deepEqual({ ...db.get<Record<string, unknown>>("SELECT route,proxy_jump_machine_id FROM host_ssh_accounts WHERE account_id='ssh_old'") }, { route: "direct", proxy_jump_machine_id: null }, "existing accounts stay direct");
      assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM host_ssh_link_tests")?.n, 0);
      assert.throws(() => db.run("UPDATE host_ssh_accounts SET route='bogus' WHERE account_id='ssh_old'"), /CHECK/);
      db.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relay accounts are delivered only when the switch, both agents and a pinned host key allow it, and the matrix says which is missing", () => {
  const f = fixture();
  f.service.saveRelaySettings(f.principal, { enabled: true, revision: 0 });
  const behindNat = addAccount(f, "a", "behind-nat", { route: "relay" }, "192.168.1.5");
  const either = addAccount(f, "b", "either", { route: "auto" }, "203.0.113.7");
  // An account whose host key has not been pinned yet: the inspection helper pins one by default, so clear it.
  f.db.run("UPDATE host_ssh_accounts SET host_keys_json='[]'");
  const caps = (override: Record<string, { connected: boolean; ssh: boolean; routes: boolean; relay: boolean }> = {}) => (id: string) => override[id] ?? { connected: true, ssh: true, routes: true, relay: true };
  const cell = (matrix: ReturnType<typeof f.service.matrix>, account: string, source: string) => matrix.links.find(link => link.accountId === account)!.sources.find(item => item.machineId === source)!;

  assert.equal(cell(f.service.matrix(f.principal, caps()), behindNat.id, "c").reason, "host_key_unpinned", "the panel in the middle needs a pinned key to be detectable");
  assert.deepEqual(f.service.desired("c", false).map(account => account.alias), [], "nothing is delivered until the key is pinned");

  const pinned = (id: string) => f.service.recordInspection(id, parseInspection({ userExists: true, authorized: true, hostKeys: [keyPair().publicKey], addresses: ["192.168.1.5"], port: 22 }));
  pinned(behindNat.id); pinned(either.id);
  assert.equal(cell(f.service.matrix(f.principal, caps()), behindNat.id, "c").state, "untested");
  const delivered = f.service.desired("c", false);
  assert.deepEqual(delivered.map(account => [account.alias, account.route]).sort(), [["af-behind-nat", "relay"], ["af-either", "auto"]]);
  assert.equal(f.service.desired("a", false).some(account => account.alias === "af-behind-nat"), false, "never to the host it points at");

  // An older agent cannot carry it, and a target known not to support it is excluded; an offline one is only unknown.
  assert.equal(cell(f.service.matrix(f.principal, caps({ c: { connected: true, ssh: true, routes: true, relay: false } })), behindNat.id, "c").reason, "relay_unsupported");
  assert.equal(cell(f.service.matrix(f.principal, caps({ a: { connected: true, ssh: true, routes: true, relay: false } })), behindNat.id, "c").reason, "relay_unsupported", "the target's agent must carry it too");
  assert.equal(cell(f.service.matrix(f.principal, caps({ a: { connected: false, ssh: false, routes: false, relay: false } })), behindNat.id, "c").state, "untested", "offline is unknown, not unsupported");
  assert.deepEqual(f.service.desired("c", false, { relay: false }).map(account => account.alias), [], "a source agent without relay is not given relay accounts");

  // Without an address the host is still configured (ssh needs a name) but never connected to directly.
  f.service.save(f.principal, { name: "behind-nat", algorithm: "ed25519", username: "deploy", address: "" }, behindNat.id);
  f.service.recordInspection(behindNat.id, parseInspection({ userExists: true, authorized: true, hostKeys: [keyPair().publicKey], addresses: [], port: 22 }));
  assert.equal(f.service.desired("c", false).find(account => account.alias === "af-behind-nat")?.hostname, "relay.invalid");

  // Turning the switch off withdraws everything at once; the matrix explains why.
  f.service.saveRelaySettings(f.principal, { enabled: false, revision: 1 });
  assert.deepEqual(f.service.desired("c", false).map(account => account.alias), []);
  assert.equal(cell(f.service.matrix(f.principal, caps()), either.id, "c").reason, "relay_disabled");
  // A jump account may not be a relay account, and relay accounts do not take part in jump chains.
  assert.throws(() => f.service.save(f.principal, { machineId: "c", name: "hop", algorithm: "ed25519", username: "u", ...keyPair(), route: "proxyjump", proxyJumpMachineId: "a" }), /跳板机需要先登记一个直连的 SSH 账号/);
});

test("authorising a relay checks the same plan the host was given, and says why not", () => {
  const f = fixture();
  f.service.saveRelaySettings(f.principal, { enabled: true, revision: 0 });
  const relay = addAccount(f, "a", "db", { route: "relay" });
  f.service.recordInspection(relay.id, parseInspection({ userExists: true, authorized: true, hostKeys: [keyPair().publicKey], addresses: ["10.0.0.9"], port: 22 }));
  const direct = addAccount(f, "b", "plain", {});
  const ok = f.service.authoriseRelay("c", relay.id);
  assert.deepEqual(ok.ok && [ok.targetMachineId, ok.alias], ["a", "af-db"]);
  assert.deepEqual(f.service.authoriseRelay("a", relay.id), { ok: false, reason: "not_found" }, "a host cannot relay to itself");
  assert.deepEqual(f.service.authoriseRelay("c", "ssh_unknown"), { ok: false, reason: "not_found" });
  assert.deepEqual(f.service.authoriseRelay("c", direct.id), { ok: false, reason: "not_relay" });
  assert.deepEqual(f.service.authoriseRelay("win", relay.id), { ok: false, reason: "not_found" }, "an unsupported platform is never a source");
  f.service.save(f.principal, { name: "db", algorithm: "ed25519", username: "deploy", sources: ["b"] }, relay.id);
  assert.deepEqual(f.service.authoriseRelay("c", relay.id), { ok: false, reason: "not_allowed" });
  assert.equal(f.service.authoriseRelay("b", relay.id).ok, true);
});

test("upgrading a version 69 database adds the relay switch and stream records", () => {
  const root = mkdtempSync(join(osTmp(), "cp-mig70-"));
  const path = join(root, "control-plane.sqlite");
  try {
    let db = new ControlPlaneDatabase(path);
    db.sqlite.exec("DROP TABLE ssh_relay_streams; DROP TABLE host_ssh_settings; PRAGMA user_version=69");
    db.close();
    for (const round of [1, 2]) {
      db = new ControlPlaneDatabase(path);
      assert.equal(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version, 70, `round ${round}`);
      assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM host_ssh_settings")?.n, 0, "no workspace has the relay on by default");
      assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM ssh_relay_streams")?.n, 0);
      assert.throws(() => db.run("INSERT INTO ssh_relay_streams(stream_id,workspace_id,account_id,source_machine_id,target_machine_id,state,started_at,last_active_at) VALUES('s','w','a','m','n','bogus','t','t')"), /CHECK/);
      db.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
