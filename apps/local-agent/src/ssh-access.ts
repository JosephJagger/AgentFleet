import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { AgentError } from "./errors.js";
import { isRecord } from "./util.js";

/**
 * The panel distributes existing SSH accounts of other Linux hosts in the workspace. Everything lives in a
 * managed directory, reached from the user's ~/.ssh/config by one marked Include line, and is replaced as a whole.
 */
export interface SshAccount {
  id: string; alias: string; name: string; targetName: string; username: string; hostname: string; port: number;
  publicKey: string; privateKey: string; passphrase: string; hostKeys: string[]; description: string;
}
type Summary = Pick<SshAccount, "alias" | "targetName" | "username" | "description"> & { pinned?: boolean | undefined };
type Run = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

const INCLUDE_MARKER = "# AgentFleets managed SSH hosts";
const ALIAS = /^af-[a-z0-9][a-z0-9._-]{0,39}$/;
const HOSTNAME = /^[A-Za-z0-9.:%[\]-]{1,253}$/;
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})$/;
const PRIVATE_KEY = /^-----BEGIN ((?:OPENSSH|RSA|EC|ENCRYPTED)? ?PRIVATE KEY)-----\n[A-Za-z0-9+/=:,\-\s]+\n-----END \1-----\n$/;

const defaultRun: Run = (command, args, timeoutMs, env) => new Promise(resolve => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 255) : 0;
    resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
  });
});

const keyToken = (line: string) => PUBLIC_KEY.exec(line.trim().split(/\s+/).slice(0, 2).join(" "));
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

export function parseSshAccounts(value: unknown): SshAccount[] {
  if (!Array.isArray(value) || value.length > 200) throw new AgentError("SSH_REQUEST_INVALID", "SSH 配置无效");
  const seen = new Set<string>();
  return value.map(item => {
    if (!isRecord(item)) throw new AgentError("SSH_REQUEST_INVALID", "SSH 配置无效");
    const string = (key: string, max: number) => { const field = item[key]; if (typeof field !== "string" || field.length > max) throw new AgentError("SSH_REQUEST_INVALID", `SSH 配置字段 ${key} 无效`); return field; };
    const account: SshAccount = {
      id: string("id", 100), alias: string("alias", 43), name: string("name", 40), targetName: oneLine(string("targetName", 200)),
      username: string("username", 32), hostname: string("hostname", 253), port: Number(item.port),
      publicKey: string("publicKey", 16_384).trim(), privateKey: string("privateKey", 16_500), passphrase: string("passphrase", 1024),
      hostKeys: Array.isArray(item.hostKeys) ? item.hostKeys.filter((line): line is string => typeof line === "string" && Boolean(keyToken(line))).slice(0, 8) : [],
      description: oneLine(string("description", 500)),
    };
    // Every value below is written into an ssh_config file: reject anything that could add a directive.
    if (!ALIAS.test(account.alias) || seen.has(account.alias) || !HOSTNAME.test(account.hostname) || !USERNAME.test(account.username)
      || !Number.isSafeInteger(account.port) || account.port < 1 || account.port > 65535 || !keyToken(account.publicKey) || !/^[A-Za-z0-9_]+$/.test(account.id)) {
      throw new AgentError("SSH_REQUEST_INVALID", "SSH 配置字段无效");
    }
    seen.add(account.alias);
    return account;
  });
}

export class SshAccess {
  private summaries: Summary[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly home = homedir(), private readonly run: Run = defaultRun, private readonly platform: NodeJS.Platform = process.platform) {}
  get root() { return join(this.home, ".ssh", "agentfleet"); }
  get supported() { return this.platform === "linux"; }

  async handle(value: Record<string, unknown>): Promise<unknown> {
    if (!this.supported) throw new AgentError("SSH_UNSUPPORTED", "SSH 互通暂仅支持 Linux 主机");
    if (value.action === "sync") return this.sync(parseSshAccounts(value.accounts));
    if (value.action === "inspect") {
      if (typeof value.username !== "string" || !USERNAME.test(value.username) || typeof value.publicKey !== "string" || !keyToken(value.publicKey)) throw new AgentError("SSH_REQUEST_INVALID", "SSH 校验请求无效");
      return this.inspect(value.username, value.publicKey);
    }
    if (value.action === "test") {
      if (typeof value.alias !== "string" || !ALIAS.test(value.alias)) throw new AgentError("SSH_REQUEST_INVALID", "SSH 测试请求无效");
      return this.test(value.alias);
    }
    throw new AgentError("SSH_REQUEST_INVALID", "不支持的 SSH 操作");
  }

  /** Syncs replace the managed directory as a whole, so they run one at a time in arrival order. */
  sync(accounts: SshAccount[]) {
    const next = this.queue.then(() => this.apply(accounts));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(accounts: SshAccount[]): Promise<{ accounts: Record<string, { ok: boolean; error?: string }> }> {
    const results: Record<string, { ok: boolean; error?: string }> = {};
    if (!accounts.length) { await this.clear(); return { accounts: results }; }
    const sshDirectory = join(this.home, ".ssh");
    await fs.mkdir(sshDirectory, { recursive: true, mode: 0o700 });
    await fs.mkdir(join(this.root, "keys"), { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700); await fs.chmod(join(this.root, "keys"), 0o700);
    const installed: SshAccount[] = [];
    for (const account of accounts) {
      try { await this.installKey(account); installed.push(account); results[account.id] = { ok: true }; }
      catch (error) { results[account.id] = { ok: false, error: error instanceof AgentError ? error.message : "私钥安装失败" }; }
    }
    const keep = new Set(installed.map(account => account.alias));
    for (const name of await fs.readdir(join(this.root, "keys"))) if (!keep.has(name)) await fs.rm(join(this.root, "keys", name), { force: true });
    await this.write("known_hosts", installed.flatMap(account => account.hostKeys.map(line => `${account.alias} ${keyToken(line)![0]}`)).join("\n") + "\n");
    await this.write("config", this.config(installed));
    const summaries: Summary[] = installed.map(({ alias, targetName, username, description, hostKeys }) => ({ alias, targetName, username, description, pinned: hostKeys.length > 0 }));
    await this.write("HOSTS.md", this.hostsDocument(summaries));
    await this.write("state.json", JSON.stringify({ hosts: summaries }));
    await this.ensureInclude();
    this.summaries = summaries;
    return { accounts: results };
  }

  private async installKey(account: SshAccount) {
    const text = `${account.privateKey.replace(/\r\n?/g, "\n").trim()}\n`;
    if (!PRIVATE_KEY.test(text)) throw new AgentError("SSH_KEY_INVALID", "私钥格式无效");
    const target = join(this.root, "keys", account.alias);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, text, { mode: 0o600 });
      // Agents run non-interactively, so an encrypted key is stored without its passphrase in this 0600 file.
      if (account.passphrase) {
        // The passphrase travels in the child's environment, never in its argv: command lines are readable by every local user,
        // while /proc/<pid>/environ is limited to the same user and root.
        const askpass = await this.askpassScript();
        const decrypted = await this.run("ssh-keygen", ["-p", "-q", "-N", "", "-f", temporary], 15_000,
          { AGENTFLEET_KEY_PASSPHRASE: account.passphrase, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || "agentfleet:0" });
        if (decrypted.code !== 0) throw new AgentError("SSH_PASSPHRASE_INVALID", "私钥口令不正确");
      }
      const derived = await this.run("ssh-keygen", ["-y", "-P", "", "-f", temporary], 15_000);
      // In askpass mode ssh-keygen can exit 0 after a wrong passphrase, so the key still being locked is the authoritative signal.
      if (derived.code !== 0) throw account.passphrase ? new AgentError("SSH_PASSPHRASE_INVALID", "私钥口令不正确或私钥无法解密") : new AgentError("SSH_KEY_INVALID", "私钥无法读取，若已加密请填写口令");
      if (keyToken(derived.stdout)?.[2] !== keyToken(account.publicKey)?.[2]) throw new AgentError("SSH_KEY_MISMATCH", "私钥与公钥不匹配");
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  /** A fixed helper that only echoes an environment variable; it contains no secret and is safe to leave on disk. */
  private async askpassScript() {
    const path = join(this.root, "askpass.sh");
    await fs.writeFile(path, "#!/bin/sh\nprintf '%s\\n' \"$AGENTFLEET_KEY_PASSPHRASE\"\n", { mode: 0o700 });
    await fs.chmod(path, 0o700);
    return path;
  }

  private config(accounts: SshAccount[]) {
    const lines = ["# Managed by AgentFleets. This file is replaced on every sync; edit hosts in the panel.", ""];
    for (const account of accounts) {
      const pinned = account.hostKeys.length > 0;
      lines.push(`# ${account.targetName.replace(/[^\p{L}\p{N} ._-]/gu, "")}`, `Host ${account.alias}`, `  HostName ${account.hostname}`, `  Port ${account.port}`, `  User ${account.username}`,
        `  IdentityFile "${join(this.root, "keys", account.alias)}"`, "  IdentitiesOnly yes", `  HostKeyAlias ${account.alias}`,
        `  UserKnownHostsFile "${join(this.root, pinned ? "known_hosts" : "known_hosts.learned")}"`,
        `  StrictHostKeyChecking ${pinned ? "yes" : "accept-new"}`, "  BatchMode yes", "  ConnectTimeout 10", "  ServerAliveInterval 30", "");
    }
    return lines.join("\n");
  }

  private hostsDocument(accounts: Summary[]) {
    return ["# AgentFleets 可访问主机", "", "本文件由 AgentFleets 面板生成，请勿手动修改。", "", ...accounts.map(account =>
      `- \`ssh ${account.alias}\` → ${account.targetName}（用户 ${account.username}）${account.description ? `：${account.description}` : ""}${account.pinned === false ? "（主机指纹未固定，首次连接自动信任）" : ""}`), ""].join("\n");
  }

  private async write(name: string, content: string) {
    const path = join(this.root, name); const temporary = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, path);
  }

  private async readConfig(): Promise<string> {
    try { return await fs.readFile(join(this.home, ".ssh", "config"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }

  /** Include must precede every Host block, otherwise ssh scopes it to that block. */
  private async ensureInclude() {
    const current = await this.readConfig();
    if (current.split("\n").includes(INCLUDE_MARKER)) return;
    await this.writeUserConfig(`${INCLUDE_MARKER}\nInclude "${join(this.root, "config")}"\n\n${current}`);
  }

  private async writeUserConfig(content: string) {
    const path = join(this.home, ".ssh", "config"); const temporary = `${path}.agentfleet.tmp`;
    const mode = await fs.stat(path).then(stat => stat.mode & 0o777, () => 0o600);
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, path);
  }

  async clear() {
    const current = await this.readConfig();
    const lines = current.split("\n"); const index = lines.indexOf(INCLUDE_MARKER);
    if (index >= 0) {
      lines.splice(index, lines[index + 1]?.startsWith("Include ") ? 2 : 1);
      if (lines[index] === "") lines.splice(index, 1);
      await this.writeUserConfig(lines.join("\n"));
    }
    await fs.rm(this.root, { recursive: true, force: true });
    this.summaries = [];
  }

  /** Runs on the host being registered: checks the account and reports what sources need to trust it. */
  async inspect(username: string, publicKey: string) {
    const entry = await this.run("getent", ["passwd", username], 5_000);
    const home = entry.code === 0 ? entry.stdout.trim().split(":")[5] : undefined;
    const token = keyToken(publicKey)![2]!;
    let authorized: boolean | null = home ? false : null;
    if (home) for (const file of ["authorized_keys", "authorized_keys2"]) {
      try {
        const content = await fs.readFile(join(home, ".ssh", file), "utf8");
        if (content.split("\n").some(line => !line.trimStart().startsWith("#") && line.split(/\s+/).includes(token))) { authorized = true; break; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") authorized = null; }
    }
    const hostKeys: string[] = [];
    for (const type of ["ed25519", "ecdsa", "rsa"]) {
      try { const match = keyToken(await fs.readFile(`/etc/ssh/ssh_host_${type}_key.pub`, "utf8")); if (match) hostKeys.push(match[0]); } catch { /* absent key type */ }
    }
    return { userExists: entry.code === 0 ? true : entry.code === 2 ? false : null, authorized, hostKeys, addresses: this.addresses(), port: await this.sshdPort() };
  }

  private async sshdPort(): Promise<number> {
    // Debian/Ubuntu's sshd_config Includes sshd_config.d first, and sshd keeps the first Port it reads.
    const dropIns = await fs.readdir("/etc/ssh/sshd_config.d").then(names => names.filter(name => name.endsWith(".conf")).sort().map(name => `/etc/ssh/sshd_config.d/${name}`), () => []);
    for (const file of [...dropIns, "/etc/ssh/sshd_config"]) {
      try { const match = /^\s*Port\s+(\d+)/mi.exec(await fs.readFile(file, "utf8")); if (match) return Number(match[1]); } catch { /* unreadable */ }
    }
    return 22;
  }

  private addresses() {
    const candidates: { address: string; rank: number }[] = [];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      if (/^(docker|br-|veth|virbr|cni|flannel|cali|lo)/.test(name)) continue;
      for (const entry of entries ?? []) {
        if (entry.internal || entry.address.startsWith("fe80:")) continue;
        candidates.push({ address: entry.address, rank: entry.family === "IPv4" ? 0 : 1 });
      }
    }
    return candidates.sort((a, b) => a.rank - b.rank).map(item => item.address).slice(0, 16);
  }

  async test(alias: string) {
    const started = Date.now();
    const result = await this.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, "true"], 20_000);
    const error = result.code === 0 ? undefined : result.stderr.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) || `ssh 退出码 ${result.code}`;
    return { ok: result.code === 0, durationMs: Date.now() - started, ...(error ? { error } : {}) };
  }

  /** Hosts this machine can reach, for agent instructions. Loaded lazily from the last sync. */
  async hosts(): Promise<Summary[]> {
    if (!this.supported) return [];
    if (this.summaries) return this.summaries;
    try {
      const state = JSON.parse(await fs.readFile(join(this.root, "state.json"), "utf8")) as { hosts?: unknown };
      this.summaries = Array.isArray(state.hosts) ? state.hosts.filter((host): host is Summary => isRecord(host) && typeof host.alias === "string" && ALIAS.test(host.alias)).map(host => ({ ...host, pinned: typeof host.pinned === "boolean" ? host.pinned : undefined })) : [];
    } catch { this.summaries = []; }
    return this.summaries;
  }

  async instructions(): Promise<string | undefined> {
    const hosts = await this.hosts();
    if (!hosts.length) return undefined;
    return [
      "## AgentFleets 主机互通（SSH）",
      "本机已由 AgentFleets 配置以下主机的 SSH 访问（非交互），可直接运行 `ssh <别名> '<命令>'`，或用 `scp`/`rsync` 传输文件。指纹状态按各主机标注：",
      ...hosts.map(host => `- ${host.alias} → ${oneLine(host.targetName)}（用户 ${host.username}）${host.description ? `：${oneLine(host.description)}` : ""}${host.pinned === true ? " [主机指纹已固定]" : host.pinned === false ? " [主机指纹未固定，首次连接自动信任并记住]" : ""}`),
      `在远程主机上执行修改性或破坏性操作前，先说明目标主机和意图。完整清单见 ${join(this.root, "HOSTS.md")}。`,
    ].join("\n");
  }
}

export const sshAccess = new SshAccess();
