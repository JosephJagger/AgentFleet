import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invariant } from "./errors.js";

/** AES-256-GCM for secrets at rest. The key lives in a 0600 file beside the database, never in it. */
export class SecretBox {
  private key: Buffer | undefined;
  constructor(private readonly databasePath: string, private readonly keyFile: string) {}

  private encryptionKey() {
    if (this.key) return this.key;
    if (this.databasePath === ":memory:") return this.key = randomBytes(32);
    const path = join(dirname(this.databasePath), this.keyFile);
    try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.key = readFileSync(path);
    invariant(this.key.length === 32, 503, "SECRET_KEY_INVALID", "Secret encryption key is unavailable");
    return this.key;
  }

  encrypt(value: string) {
    if (!value) return "";
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  decrypt(value: string) {
    if (!value) return "";
    const bytes = Buffer.from(value, "base64"); const cipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
  }
}
