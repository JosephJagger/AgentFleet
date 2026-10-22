import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { AppError, invariant } from "./errors.js";
import { newId, nowIso } from "./crypto.js";
import { SecretBox } from "./secret-box.js";

/**
 * Hosts already own their SSH accounts and key pairs. The panel only records them (secrets encrypted at rest)
 * and distributes them to the workspace's other Linux and macOS hosts so their agents can `ssh af-<name>`.
 */
export const SSH_ALGORITHMS = ["ed25519", "rsa", "ecdsa"] as const;
export type SshAlgorithm = (typeof SSH_ALGORITHMS)[number];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const ADDRESS = /^[A-Za-z0-9.:%[\]-]{1,253}$/;
const MAX_PRIVATE_KEY = 16_384;

export const isSshPlatform = (platform: string | null | undefined) => ["linux", "ubuntu", "darwin", "macos"].includes(String(platform).toLowerCase());
/** Routes a user may select today. 'auto' and 'relay' exist in the schema for the panel relay but are not offered yet. */
export const SSH_ROUTES = ["direct", "proxyjump"] as const;
export type SshRoute = (typeof SSH_ROUTES)[number];
export const ADDRESS_KINDS = ["lan", "public", "overlay"] as const;
export const sshAlias = (name: string) => `af-${name.toLowerCase()}`;

function readString(buffer: Buffer, offset: number): { value: Buffer; next: number } {
  invariant(offset + 4 <= buffer.length, 400, "SSH_KEY_INVALID", "SSH key encoding is truncated");
  const length = buffer.readUInt32BE(offset);
  invariant(offset + 4 + length <= buffer.length, 400, "SSH_KEY_INVALID", "SSH key encoding is truncated");
  return { value: buffer.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

export interface SshPublicKey { type: string; algorithm: SshAlgorithm; blob: Buffer; line: string; fingerprint: string }
export function parseSshPublicKey(input: string): SshPublicKey {
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/]+={0,2})(?:\s+.*)?$/.exec(input.trim());
  invariant(match, 400, "SSH_PUBLIC_KEY_INVALID", "公钥格式无效，应为 ssh-ed25519 / ssh-rsa / ecdsa-sha2-* 开头的单行公钥");
  const type = match[1]!; const blob = Buffer.from(match[2]!, "base64");
  invariant(readString(blob, 0).value.toString("latin1") === type, 400, "SSH_PUBLIC_KEY_INVALID", "公钥内容与类型不一致");
  const algorithm: SshAlgorithm = type === "ssh-ed25519" ? "ed25519" : type === "ssh-rsa" ? "rsa" : "ecdsa";
  return { type, algorithm, blob, line: `${type} ${blob.toString("base64")}`, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
}

/** OpenSSH private keys carry their public key in clear text, even when the private part is encrypted. */
export function parseSshPrivateKey(input: string): { text: string; encrypted: boolean | null; publicBlob?: Buffer } {
  const text = `${input.replace(/\r\n?/g, "\n").trim()}\n`;
  invariant(text.length <= MAX_PRIVATE_KEY, 400, "SSH_PRIVATE_KEY_INVALID", "私钥过大");
  const match = /^-----BEGIN ((?:OPENSSH|RSA|EC|ENCRYPTED)? ?PRIVATE KEY)-----\n([\s\S]+?)\n-----END \1-----\n$/.exec(text);
  invariant(match, 400, "SSH_PRIVATE_KEY_INVALID", "私钥格式无效，应为完整的 -----BEGIN ... PRIVATE KEY----- 文本");
  if (match[1] !== "OPENSSH PRIVATE KEY") return { text, encrypted: match[1] === "ENCRYPTED PRIVATE KEY" || /Proc-Type: 4,ENCRYPTED/.test(match[2]!) ? true : null };
  const body = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
  const magic = Buffer.from("openssh-key-v1\0", "latin1");
  invariant(body.subarray(0, magic.length).equals(magic), 400, "SSH_PRIVATE_KEY_INVALID", "不是有效的 OpenSSH 私钥");
  const cipher = readString(body, magic.length);
  const kdf = readString(body, cipher.next);
  const options = readString(body, kdf.next);
  invariant(options.next + 4 <= body.length && body.readUInt32BE(options.next) === 1, 400, "SSH_PRIVATE_KEY_INVALID", "仅支持包含单个密钥的私钥文件");
  const publicBlob = readString(body, options.next + 4).value;
  return { text, encrypted: cipher.value.toString("latin1") !== "none", publicBlob };
}

/** PEM keys do not embed an OpenSSH public blob; derive it locally without shelling out. */
function pemPublicKey(privateKey: string, passphrase?: string): SshPublicKey {
  let jwk;
  try { jwk = createPublicKey(createPrivateKey({ key: privateKey, ...(passphrase ? { passphrase } : {}) })).export({ format: "jwk" }); }
  catch { throw new AppError(400, "SSH_PRIVATE_KEY_INVALID", "无法读取私钥，请检查私钥内容和口令"); }
  const field = (value: string | Buffer) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const integer = (value: string) => {
    let bytes = Buffer.from(value, "base64url");
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
    return field(bytes[0]! & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
  };
  let type: string; let blob: Buffer;
  if (jwk.kty === "RSA" && jwk.e && jwk.n) {
    type = "ssh-rsa"; blob = Buffer.concat([field(type), integer(jwk.e), integer(jwk.n)]);
  } else if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x) {
    type = "ssh-ed25519"; blob = Buffer.concat([field(type), field(Buffer.from(jwk.x, "base64url"))]);
  } else if (jwk.kty === "EC" && jwk.x && jwk.y && ["P-256", "P-384", "P-521"].includes(jwk.crv ?? "")) {
    const curve = `nistp${jwk.crv!.slice(2)}`;
    type = `ecdsa-sha2-${curve}`;
    blob = Buffer.concat([field(type), field(curve), field(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]))]);
  } else throw new AppError(400, "SSH_ALGORITHM_INVALID", "不支持的加密方式");
  return parseSshPublicKey(`${type} ${blob.toString("base64")}`);
}

const aliasName = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[._-]+$/g, "").slice(0, 40);

interface AccountRow {
  account_id: string; workspace_id: string; machine_id: string; name: string; algorithm: SshAlgorithm; username: string;
  address: string; port: number; public_key: string; fingerprint: string; encrypted_private_key: string; encrypted_passphrase: string;
  host_keys_json: string; verification_json: string; description: string; enabled: number; created_at: string; updated_at: string;
  route: string; proxy_jump_machine_id: string | null;
}
export interface SshInspection {
  userExists: boolean | null; authorized: boolean | null; addresses: string[]; addressKinds?: Record<string, string>; port: number | null;
  /** Whether sshd accepts connections on this host (macOS: Remote Login enabled). */
  listening?: boolean | null; checkedAt: string; error?: string;
}
export interface SshDesiredAccount {
  id: string; alias: string; name: string; targetName: string; username: string; hostname: string; port: number;
  publicKey: string; privateKey: string; passphrase: string; hostKeys: string[]; description: string;
  /** Alias of the direct account this connection hops through; absent for direct routes. */
  proxyJump?: string;
}
export interface SshSyncResult { accounts: Record<string, { ok: boolean; error?: string }> }
export interface SshTestResult { machineId: string; machineName: string; ok: boolean; durationMs?: number; error?: string; path?: "direct" | "proxyjump" }
export type SshExclusion = "disabled" | "not_allowed" | "target_unsupported" | "no_address" | "jump_missing" | "routes_unsupported";
export type SshLinkState = "ok" | "failed" | "untested" | "excluded" | "unsupported";
/** One cell of the matrix: a source host's standing for one target account. */
export interface SshMatrixSource {
  machineId: string; machineName: string; agent: "ready" | "outdated" | "offline"; state: SshLinkState;
  reason?: string; via?: string; delivered?: { ok: boolean; error?: string };
  path?: string; testedAt?: string; durationMs?: number; error?: string;
}

/** Sends one request to one host's connection service and resolves with its `ssh.result`. */
export interface SshEndpoint { key: object; ready: boolean; supported: boolean; send: (value: Record<string, unknown>) => boolean }
export class SshAccessBroker {
  private pending = new Map<string, { machineId: string; key: object; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private endpoint: (machineId: string) => SshEndpoint | undefined) {}
  available(machineId: string) { const endpoint = this.endpoint(machineId); return Boolean(endpoint?.ready && endpoint.supported); }
  request(machineId: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const endpoint = this.endpoint(machineId);
    if (!endpoint?.ready) return Promise.reject(new AppError(409, "SSH_HOST_OFFLINE", "主机离线或正在同步"));
    if (!endpoint.supported) return Promise.reject(new AppError(409, "SSH_UNSUPPORTED", "请更新主机连接服务以使用 SSH 互通"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new AppError(504, "SSH_TIMEOUT", "主机响应超时")); }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { machineId, key: endpoint.key, resolve, reject, timer });
      if (!endpoint.send({ type: "ssh.request", requestId, ...payload })) { clearTimeout(timer); this.pending.delete(requestId); reject(new AppError(409, "SSH_HOST_OFFLINE", "主机连接已断开")); }
    });
  }
  receive(machineId: string, key: object, message: { requestId?: unknown; result?: unknown; error?: unknown }) {
    const pending = typeof message.requestId === "string" ? this.pending.get(message.requestId) : undefined;
    if (!pending || pending.machineId !== machineId || pending.key !== key) return;
    clearTimeout(pending.timer); this.pending.delete(message.requestId as string);
    if (message.error && typeof message.error === "object") {
      const error = message.error as Record<string, unknown>;
      const code = typeof error.code === "string" && /^SSH_[A-Z_]{1,60}$/.test(error.code) ? error.code : "SSH_HOST_FAILED";
      pending.reject(new AppError(409, code, typeof error.message === "string" ? error.message.slice(0, 500) : "主机执行失败"));
    } else pending.resolve(message.result);
  }
  disconnect(machineId: string, key: object) {
    for (const [id, pending] of this.pending) if (pending.machineId === machineId && pending.key === key) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new AppError(409, "SSH_HOST_OFFLINE", "主机连接已断开"));
    }
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError(503, "SSH_HOST_OFFLINE", "服务正在关闭")); }
    this.pending.clear();
  }
}

interface PlanEntry { row: AccountRow & { target_name: string; target_platform: string; target_state: string }; hostname?: string; excluded?: SshExclusion; jumpAlias?: string }
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max ? value : undefined;
const stringList = (value: unknown, max: number, each: number) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= each).slice(0, max) : [];

export function parseInspection(value: unknown): SshInspection & { hostKeys: string[] } {
  invariant(value && typeof value === "object" && !Array.isArray(value), 502, "SSH_INSPECTION_INVALID", "主机返回的校验结果无效");
  const raw = value as Record<string, unknown>;
  const flag = (item: unknown) => typeof item === "boolean" ? item : null;
  const hostKeys = stringList(raw.hostKeys, 8, 2048).flatMap(line => { try { return [parseSshPublicKey(line).line]; } catch { return []; } });
  const addresses = stringList(raw.addresses, 16, 64).filter(address => ADDRESS.test(address));
  const kinds = raw.addressKinds && typeof raw.addressKinds === "object" && !Array.isArray(raw.addressKinds) ? raw.addressKinds as Record<string, unknown> : {};
  const addressKinds = Object.fromEntries(addresses.flatMap(address => (ADDRESS_KINDS as readonly unknown[]).includes(kinds[address]) ? [[address, kinds[address] as string]] : []));
  return {
    userExists: flag(raw.userExists), authorized: flag(raw.authorized),
    addresses, ...(Object.keys(addressKinds).length ? { addressKinds } : {}), listening: flag(raw.listening),
    port: Number.isSafeInteger(raw.port) && Number(raw.port) > 0 && Number(raw.port) < 65536 ? Number(raw.port) : null,
    checkedAt: nowIso(), hostKeys,
  };
}

export class SshAccessService {
  private readonly secrets: SecretBox;
  constructor(private readonly db: ControlPlaneDatabase, databasePath: string) {
    this.secrets = new SecretBox(databasePath, "ssh-access.key");
  }

  private machine(principal: Principal, machineId: string) {
    const machine = this.db.get<{ machine_id: string; name: string; display_alias: string | null; platform: string; identity_state: string }>(
      "SELECT machine_id,name,display_alias,platform,identity_state FROM machines WHERE machine_id=? AND workspace_id=?", machineId, principal.workspaceId);
    invariant(machine && machine.identity_state === "active", 404, "MACHINE_NOT_FOUND", "Machine was not found");
    return machine;
  }

  private row(principal: Principal, accountId: string) {
    const row = this.db.get<AccountRow>("SELECT * FROM host_ssh_accounts WHERE account_id=? AND workspace_id=?", accountId, principal.workspaceId);
    invariant(row, 404, "SSH_ACCOUNT_NOT_FOUND", "SSH 账号不存在");
    return row;
  }

  private view(row: AccountRow) {
    const verification = JSON.parse(row.verification_json) as Partial<SshInspection>;
    const sources = this.db.all<{ source_machine_id: string }>("SELECT source_machine_id FROM host_ssh_access WHERE account_id=? ORDER BY source_machine_id", row.account_id).map(item => item.source_machine_id);
    const sync = this.db.all<{ machine_id: string; results_json: string; synced_at: string }>("SELECT machine_id,results_json,synced_at FROM host_ssh_sync");
    const delivered = sync.flatMap(item => {
      const result = (JSON.parse(item.results_json) as SshSyncResult["accounts"])[row.account_id];
      return result ? [{ machineId: item.machine_id, ok: result.ok, ...(result.error ? { error: result.error } : {}), syncedAt: item.synced_at }] : [];
    });
    const hostKeys = JSON.parse(row.host_keys_json) as string[];
    return {
      id: row.account_id, machineId: row.machine_id, name: row.name, alias: sshAlias(row.name), algorithm: row.algorithm, username: row.username,
      address: row.address, port: row.port, effectiveAddress: row.address || verification.addresses?.[0] || "",
      publicKey: row.public_key, fingerprint: row.fingerprint, hasPrivateKey: Boolean(row.encrypted_private_key), hasPassphrase: Boolean(row.encrypted_passphrase),
      hostKeyFingerprints: hostKeys.map(line => parseSshPublicKey(line).fingerprint), verification, description: row.description,
      route: row.route, proxyJumpMachineId: row.proxy_jump_machine_id,
      enabled: row.enabled === 1, sources, delivered, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  list(principal: Principal, machineId?: string) {
    const rows = machineId
      ? this.db.all<AccountRow>("SELECT * FROM host_ssh_accounts WHERE workspace_id=? AND machine_id=? ORDER BY name", principal.workspaceId, machineId)
      : this.db.all<AccountRow>("SELECT * FROM host_ssh_accounts WHERE workspace_id=? ORDER BY name", principal.workspaceId);
    return rows.map(row => this.view(row));
  }

  /** Accounts the given host may use, as aliases only; secrets never leave the server through this path. */
  reachable(principal: Principal, sourceMachineId: string, options: { routes?: boolean } = {}) {
    this.machine(principal, sourceMachineId);
    return this.desired(sourceMachineId, false, options).map(({ privateKey: _p, passphrase: _s, ...account }) => account);
  }

  get(principal: Principal, accountId: string) { return this.view(this.row(principal, accountId)); }

  save(principal: Principal, body: Record<string, unknown>, accountId?: string) {
    const previous = accountId ? this.row(principal, accountId) : undefined;
    const machineId = previous?.machine_id ?? text(body.machineId, 300);
    invariant(machineId, 400, "INVALID_INPUT", "machineId is required");
    const machine = this.machine(principal, machineId);
    invariant(isSshPlatform(machine.platform), 409, "SSH_PLATFORM_UNSUPPORTED", "SSH 互通仅支持 Linux 和 macOS 主机");
    const automaticName = body.name === undefined && !previous;
    let name = body.name === undefined ? previous?.name ?? (aliasName(machine.display_alias ?? "") || aliasName(machine.name) || aliasName(machineId)) : text(body.name, 40)?.trim() ?? "";
    invariant(NAME.test(name), 400, "SSH_NAME_INVALID", "名称仅支持字母、数字、点、下划线和连字符，最长 40 位");
    const username = text(body.username, 32)?.trim() ?? "";
    invariant(USERNAME.test(username), 400, "SSH_USERNAME_INVALID", "请填写有效的系统用户名");
    const address = text(body.address, 253)?.trim() ?? "";
    invariant(!address || ADDRESS.test(address), 400, "SSH_ADDRESS_INVALID", "地址应为主机名或 IP");
    const port = body.port === undefined || body.port === null || body.port === "" ? 22 : Number(body.port);
    invariant(Number.isSafeInteger(port) && port > 0 && port < 65536, 400, "SSH_PORT_INVALID", "端口应在 1-65535 之间");
    const description = (text(body.description, 500) ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

    const privateInput = text(body.privateKey, MAX_PRIVATE_KEY + 64)?.trim();
    invariant(privateInput || previous, 400, "SSH_PRIVATE_KEY_REQUIRED", "请填写私钥");
    const privateKey = privateInput ? parseSshPrivateKey(privateInput) : undefined;
    const passphrase = typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined;
    invariant(!passphrase || passphrase.length <= 1024, 400, "SSH_PASSPHRASE_INVALID", "口令过长");
    const encryptedPassphrase = body.clearPassphrase === true ? "" : passphrase ? this.secrets.encrypt(passphrase) : privateKey ? "" : previous?.encrypted_passphrase ?? "";
    if (privateKey?.encrypted) invariant(encryptedPassphrase, 400, "SSH_PASSPHRASE_REQUIRED", "该私钥已加密，请填写口令");

    const derived = privateKey?.publicBlob ? parseSshPublicKey(`${readString(privateKey.publicBlob, 0).value.toString("latin1")} ${privateKey.publicBlob.toString("base64")}`)
      : privateKey ? pemPublicKey(privateKey.text, passphrase) : undefined;
    const publicInput = text(body.publicKey, 16_384)?.trim();
    const publicKey = publicInput ? parseSshPublicKey(publicInput) : derived ?? (previous ? parseSshPublicKey(previous.public_key) : undefined);
    invariant(publicKey, 400, "SSH_PUBLIC_KEY_REQUIRED", "无法从私钥读取公钥");
    const algorithm = body.algorithm === undefined ? publicKey.algorithm : body.algorithm as SshAlgorithm;
    invariant(SSH_ALGORITHMS.includes(algorithm), 400, "SSH_ALGORITHM_INVALID", "不支持的加密方式");
    invariant(publicKey.algorithm === algorithm, 400, "SSH_ALGORITHM_MISMATCH", "加密方式与公钥类型不一致");
    if (derived) invariant(derived.blob.equals(publicKey.blob), 400, "SSH_KEY_MISMATCH", "私钥与公钥不匹配");
    if (!privateKey && previous) invariant(previous.public_key === publicKey.line, 400, "SSH_PRIVATE_KEY_REQUIRED", "更换公钥时请同时填写对应私钥");

    const route = (body.route === undefined ? previous?.route ?? "direct" : body.route) as SshRoute;
    invariant((SSH_ROUTES as readonly unknown[]).includes(route), 400, "SSH_ROUTE_INVALID", "暂不支持该路由方式");
    let jumpMachineId: string | null = null;
    if (route === "proxyjump") {
      const requested = body.proxyJumpMachineId === undefined ? previous?.proxy_jump_machine_id ?? undefined : text(body.proxyJumpMachineId, 300);
      invariant(requested, 400, "SSH_JUMP_REQUIRED", "请选择跳板机");
      invariant(requested !== machineId, 400, "SSH_JUMP_INVALID", "跳板机不能是目标主机自身");
      invariant(isSshPlatform(this.machine(principal, requested).platform), 409, "SSH_PLATFORM_UNSUPPORTED", "SSH 互通仅支持 Linux 和 macOS 主机");
      invariant(this.db.get("SELECT 1 AS found FROM host_ssh_accounts WHERE workspace_id=? AND machine_id=? AND enabled=1 AND route='direct'", principal.workspaceId, requested),
        409, "SSH_JUMP_ACCOUNT_REQUIRED", "跳板机需要先登记一个直连的 SSH 账号");
      // Chains are never configured: a host that other accounts hop through must stay direct.
      invariant(!this.db.get("SELECT 1 AS found FROM host_ssh_accounts WHERE workspace_id=? AND proxy_jump_machine_id=? AND account_id<>?", principal.workspaceId, machineId, previous?.account_id ?? ""),
        409, "SSH_JUMP_IN_USE", "该主机正作为其他账号的跳板机，不能再经跳板连接");
      jumpMachineId = requested;
    }
    const sources = Array.isArray(body.sources) ? [...new Set(body.sources.filter((id): id is string => typeof id === "string"))] : undefined;
    for (const source of sources ?? []) {
      invariant(source !== machineId, 400, "SSH_SOURCE_INVALID", "无需授权主机访问自身");
      invariant(isSshPlatform(this.machine(principal, source).platform), 409, "SSH_PLATFORM_UNSUPPORTED", "SSH 互通仅支持 Linux 和 macOS 主机");
    }
    const enabled = body.enabled === false ? 0 : 1;
    const id = previous?.account_id ?? newId("ssh");
    const now = nowIso();
    const keyChanged = !previous || previous.public_key !== publicKey.line || previous.username !== username;
    // Test outcomes describe a specific path; any change to it makes them stale.
    const pathChanged = Boolean(previous) && (previous!.route !== route || previous!.proxy_jump_machine_id !== jumpMachineId || previous!.address !== address || previous!.port !== port);
    return this.db.transaction(() => {
      if (automaticName) {
        const base = name;
        for (let suffix = 2; this.db.get("SELECT 1 FROM host_ssh_accounts WHERE workspace_id=? AND name=? COLLATE NOCASE", principal.workspaceId, name); suffix++) {
          const tail = `-${suffix}`; name = base.slice(0, 40 - tail.length) + tail;
        }
      }
      invariant(!this.db.get("SELECT 1 AS found FROM host_ssh_accounts WHERE workspace_id=? AND name=? COLLATE NOCASE AND account_id<>?", principal.workspaceId, name, id), 409, "SSH_NAME_TAKEN", "名称已被使用");
      if (previous) this.db.run(
        `UPDATE host_ssh_accounts SET name=?,algorithm=?,username=?,address=?,port=?,public_key=?,fingerprint=?,encrypted_private_key=?,encrypted_passphrase=?,
         verification_json=?,description=?,enabled=?,route=?,proxy_jump_machine_id=?,updated_at=? WHERE account_id=?`,
        name, algorithm, username, address, port, publicKey.line, publicKey.fingerprint,
        privateKey ? this.secrets.encrypt(privateKey.text) : previous.encrypted_private_key, encryptedPassphrase,
        keyChanged ? "{}" : previous.verification_json, description, enabled, route, jumpMachineId, now, id);
      else this.db.run(
        `INSERT INTO host_ssh_accounts(account_id,workspace_id,machine_id,name,algorithm,username,address,port,public_key,fingerprint,
         encrypted_private_key,encrypted_passphrase,description,enabled,route,proxy_jump_machine_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, principal.workspaceId, machineId, name, algorithm, username, address, port, publicKey.line, publicKey.fingerprint,
        this.secrets.encrypt(privateKey!.text), encryptedPassphrase, description, enabled, route, jumpMachineId, now, now);
      if (previous && (keyChanged || pathChanged)) this.db.run("DELETE FROM host_ssh_link_tests WHERE account_id=?", id);
      if (sources) {
        this.db.run("DELETE FROM host_ssh_access WHERE account_id=?", id);
        for (const source of sources) this.db.run("INSERT INTO host_ssh_access(account_id,source_machine_id) VALUES(?,?)", id, source);
      }
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, machineId,
        action: previous ? "ssh.account.update" : "ssh.account.create", metadata: { accountId: id, name, username, fingerprint: publicKey.fingerprint, keyReplaced: Boolean(privateKey), route, ...(jumpMachineId ? { jumpMachineId } : {}) } });
      return this.view(this.row(principal, id));
    });
  }

  remove(principal: Principal, accountId: string) {
    const row = this.row(principal, accountId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM host_ssh_accounts WHERE account_id=?", row.account_id);
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, machineId: row.machine_id,
        action: "ssh.account.delete", metadata: { accountId: row.account_id, name: row.name } });
    });
    return row.workspace_id;
  }

  recordInspection(accountId: string, inspection: SshInspection & { hostKeys: string[] }) {
    const { hostKeys, ...verification } = inspection;
    this.db.run("UPDATE host_ssh_accounts SET verification_json=?,host_keys_json=CASE WHEN ?='[]' THEN host_keys_json ELSE ? END WHERE account_id=?",
      JSON.stringify(verification), JSON.stringify(hostKeys), JSON.stringify(hostKeys), accountId);
  }

  recordInspectionFailure(accountId: string, error: string) {
    const row = this.db.get<{ verification_json: string }>("SELECT verification_json FROM host_ssh_accounts WHERE account_id=?", accountId);
    if (!row) return;
    this.db.run("UPDATE host_ssh_accounts SET verification_json=? WHERE account_id=?", JSON.stringify({ ...JSON.parse(row.verification_json), error, checkedAt: nowIso() }), accountId);
  }

  recordSync(machineId: string, revision: string, value: unknown) {
    const accounts = value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).accounts;
    const results: SshSyncResult["accounts"] = {};
    if (accounts && typeof accounts === "object") for (const [id, result] of Object.entries(accounts as Record<string, unknown>).slice(0, 500)) {
      if (!result || typeof result !== "object") continue;
      const item = result as Record<string, unknown>;
      results[id.slice(0, 100)] = { ok: item.ok === true, ...(typeof item.error === "string" ? { error: item.error.slice(0, 300) } : {}) };
    }
    this.db.run(`INSERT INTO host_ssh_sync(machine_id,revision,results_json,synced_at) VALUES(?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET revision=excluded.revision,results_json=excluded.results_json,synced_at=excluded.synced_at`,
      machineId, revision, JSON.stringify(results), nowIso());
  }

  /**
   * Which accounts one source host gets, and why the others are left out. Both the sync and the matrix use this, so the
   * panel never claims a link that the host was not actually given.
   */
  private plan(sourceMachineId: string, routes: boolean) {
    const source = this.db.get<{ workspace_id: string; platform: string; identity_state: string }>("SELECT workspace_id,platform,identity_state FROM machines WHERE machine_id=?", sourceMachineId);
    if (!source || source.identity_state !== "active" || !isSshPlatform(source.platform)) return { source, entries: [] as PlanEntry[] };
    const rows = this.db.all<AccountRow & { target_name: string; target_platform: string; target_state: string }>(
      `SELECT a.*,m.name AS target_name,m.platform AS target_platform,m.identity_state AS target_state FROM host_ssh_accounts a JOIN machines m ON m.machine_id=a.machine_id
       WHERE a.workspace_id=? AND a.machine_id<>? ORDER BY a.name`, source.workspace_id, sourceMachineId);
    const allowed = new Map<string, Set<string>>();
    for (const item of this.db.all<{ account_id: string; source_machine_id: string }>(
      "SELECT s.account_id,s.source_machine_id FROM host_ssh_access s JOIN host_ssh_accounts a ON a.account_id=s.account_id WHERE a.workspace_id=?", source.workspace_id)) {
      (allowed.get(item.account_id) ?? allowed.set(item.account_id, new Set()).get(item.account_id)!).add(item.source_machine_id);
    }
    const hostnameOf = (row: AccountRow) => row.address || (JSON.parse(row.verification_json) as Partial<SshInspection>).addresses?.[0];
    const base = rows.map((row): PlanEntry => {
      const scope = allowed.get(row.account_id);
      const hostname = hostnameOf(row);
      const excluded: SshExclusion | undefined = row.enabled !== 1 ? "disabled" : scope?.size && !scope.has(sourceMachineId) ? "not_allowed"
        : row.target_state !== "active" || !isSshPlatform(row.target_platform) ? "target_unsupported" : !hostname ? "no_address" : undefined;
      return { row, ...(hostname ? { hostname } : {}), ...(excluded ? { excluded } : {}) };
    });
    // A hop must itself be a usable direct account for this source; otherwise the account is withheld, never tried directly.
    for (const entry of base) {
      if (entry.excluded || entry.row.route !== "proxyjump") continue;
      const jumpMachine = entry.row.proxy_jump_machine_id;
      if (jumpMachine === sourceMachineId) continue;
      const jump = base.find(candidate => !candidate.excluded && candidate.row.machine_id === jumpMachine && candidate.row.route === "direct");
      if (!jump) entry.excluded = "jump_missing";
      else if (!routes) entry.excluded = "routes_unsupported";
      else entry.jumpAlias = sshAlias(jump.row.name);
    }
    return { source, entries: base };
  }

  /** The complete desired state for one source host. Disabled, revoked, unsupported and out-of-scope targets are absent. */
  desired(sourceMachineId: string, withSecrets = true, options: { routes?: boolean } = {}): SshDesiredAccount[] {
    return this.plan(sourceMachineId, options.routes !== false).entries.flatMap(({ row, hostname, excluded, jumpAlias }) => {
      if (excluded || !hostname) return [];
      return [{
        id: row.account_id, alias: sshAlias(row.name), name: row.name, targetName: row.target_name, username: row.username, hostname, port: row.port,
        publicKey: row.public_key, privateKey: withSecrets ? this.secrets.decrypt(row.encrypted_private_key) : "",
        passphrase: withSecrets ? this.secrets.decrypt(row.encrypted_passphrase) : "",
        hostKeys: JSON.parse(row.host_keys_json) as string[], description: row.description,
        ...(jumpAlias ? { proxyJump: jumpAlias } : {}),
      }];
    });
  }

  recordTest(accountId: string, sourceMachineId: string, result: { ok: boolean; durationMs?: number; error?: string }, path: "direct" | "proxyjump") {
    this.db.run(`INSERT INTO host_ssh_link_tests(account_id,source_machine_id,ok,path,duration_ms,error,tested_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account_id,source_machine_id) DO UPDATE SET ok=excluded.ok,path=excluded.path,duration_ms=excluded.duration_ms,error=excluded.error,tested_at=excluded.tested_at`,
      accountId, sourceMachineId, result.ok ? 1 : 0, path, Number.isSafeInteger(result.durationMs) ? result.durationMs! : null, (result.error ?? "").slice(0, 300), nowIso());
  }

  /** Source hosts (columns) by target accounts (rows), with the latest test outcome for each pair. */
  matrix(principal: Principal, capability: (machineId: string) => { connected: boolean; ssh: boolean; routes: boolean }) {
    const machines = this.db.all<{ machine_id: string; name: string; display_alias: string | null; platform: string }>(
      "SELECT machine_id,name,display_alias,platform FROM machines WHERE workspace_id=? AND identity_state='active' ORDER BY name", principal.workspaceId);
    const accounts = this.db.all<AccountRow & { target_name: string }>(
      `SELECT a.*,m.name AS target_name FROM host_ssh_accounts a JOIN machines m ON m.machine_id=a.machine_id WHERE a.workspace_id=? ORDER BY a.name`, principal.workspaceId);
    const tests = new Map(this.db.all<{ account_id: string; source_machine_id: string; ok: number; path: string; duration_ms: number | null; error: string; tested_at: string }>(
      "SELECT t.* FROM host_ssh_link_tests t JOIN host_ssh_accounts a ON a.account_id=t.account_id WHERE a.workspace_id=?", principal.workspaceId)
      .map(row => [`${row.account_id}|${row.source_machine_id}`, row]));
    const syncs = new Map(this.db.all<{ machine_id: string; results_json: string }>("SELECT machine_id,results_json FROM host_ssh_sync").map(row => [row.machine_id, JSON.parse(row.results_json) as SshSyncResult["accounts"]]));
    const caps = new Map(machines.map(machine => [machine.machine_id, capability(machine.machine_id)]));
    // An offline host's abilities are unknown, so it is planned optimistically and marked offline; it is re-planned when it reconnects.
    const plans = new Map(machines.map(machine => {
      const cap = caps.get(machine.machine_id)!;
      return [machine.machine_id, new Map(this.plan(machine.machine_id, cap.connected ? cap.routes : true).entries.map(entry => [entry.row.account_id, entry]))];
    }));
    return {
      hosts: machines.map(machine => ({ machineId: machine.machine_id, name: machine.display_alias || machine.name, platform: machine.platform, supported: isSshPlatform(machine.platform) })),
      links: accounts.map(account => ({
        accountId: account.account_id, alias: sshAlias(account.name), targetMachineId: account.machine_id, targetName: account.target_name, route: account.route,
        proxyJumpMachineId: account.proxy_jump_machine_id, enabled: account.enabled === 1,
        sources: machines.filter(machine => machine.machine_id !== account.machine_id).map((machine): SshMatrixSource => {
          const cap = caps.get(machine.machine_id)!;
          const agent = cap.connected ? (cap.ssh ? "ready" as const : "outdated" as const) : "offline" as const;
          const head = { machineId: machine.machine_id, machineName: machine.display_alias || machine.name, agent };
          if (!isSshPlatform(machine.platform)) return { ...head, state: "unsupported", reason: "source_platform" };
          const entry = plans.get(machine.machine_id)?.get(account.account_id);
          if (entry?.excluded) return { ...head, state: "excluded", reason: entry.excluded };
          if (agent === "outdated") return { ...head, state: "unsupported", reason: "agent_outdated" };
          const delivered = syncs.get(machine.machine_id)?.[account.account_id];
          const test = tests.get(`${account.account_id}|${machine.machine_id}`);
          return {
            ...head, state: test ? (test.ok === 1 ? "ok" : "failed") : "untested",
            ...(entry?.jumpAlias ? { via: entry.jumpAlias } : {}), ...(delivered ? { delivered } : {}),
            ...(test ? { path: test.path, testedAt: test.tested_at, ...(test.duration_ms !== null ? { durationMs: test.duration_ms } : {}), ...(test.error ? { error: test.error } : {}) } : {}),
          };
        }),
      })),
    };
  }

  /** Opaque per-push revision. Never derived from content, so no digest of a secret is persisted. */
  revision() { return newId("sshrev"); }

  workspaceOf(machineId: string) { return this.db.get<{ workspace_id: string }>("SELECT workspace_id FROM machines WHERE machine_id=?", machineId)?.workspace_id; }
  machinesIn(workspaceId: string) {
    return this.db.all<{ machine_id: string; name: string; platform: string }>("SELECT machine_id,name,platform FROM machines WHERE workspace_id=? AND identity_state='active'", workspaceId)
      .filter(machine => isSshPlatform(machine.platform));
  }
  target(accountId: string) {
    return this.db.get<{ account_id: string; machine_id: string; username: string; public_key: string; name: string; workspace_id: string }>(
      "SELECT account_id,machine_id,username,public_key,name,workspace_id FROM host_ssh_accounts WHERE account_id=?", accountId);
  }
}
