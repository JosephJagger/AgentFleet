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
  for (const [machine, platform] of [["a", "linux"], ["b", "linux"], ["c", "linux"], ["mac", "darwin"]] as const) {
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
  assert.throws(() => service.save(principal, { machineId: "mac", name: "x", algorithm: "ed25519", username: "u", ...other }), /仅支持 Linux/);
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
  assert.deepEqual(service.desired("mac"), [], "non-Linux hosts receive nothing");
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
