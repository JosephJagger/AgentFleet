import { createHash, createPublicKey, verify, constants } from "node:crypto";
class AgentError extends Error { constructor(readonly code: string, message: string) { super(message); } }

/**
 * Minimal OpenPGP detached-signature verifier (RSA, v4 signatures, SHA-2) for the pinned Claude Code
 * release key. The key is embedded rather than downloaded so a compromised download origin cannot
 * replace both the manifest and the key that vouches for it.
 * Fingerprint as published in https://code.claude.com/docs/en/setup (Binary integrity and code signing).
 */
export const CLAUDE_RELEASE_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
export const CLAUDE_RELEASE_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGnK73ABEACnbytJXkjweYrwIr0aLEFRlH+C0nF44KxFc7gQmJ6PjSPMGZAD
dxZcaixU7zZl8WxEpVO0wLmIH8cf2zGOdyuZg1Yaugk1vHb2b8WBhAGCQJdPgB8W
XquedepEYtk56uP/gCoTjJDUZluEGBHnlnuujSJ4orxEdhSykEoAUfJZGEILPpMd
bphFt/Sn+Eb/TxM5jpKPdwnv8AShNF/1mZU1fWTQq9tRKJUakZj04gdaDFElQXak
CtTij+GT6yoYCARSHwGO+PC/Pr6q4tc+D7LRjxSBvUWDoFSmlqb/PJ1hj9D/7I2O
e4XXniAPWMR56KvxHlzOzrNQdJujbJdSkCwh1ZijkSd3y8ayW5WYUTGdRab99NUw
agzlabe/VVF6kzJ0Scn5q3PihB2Y9Bwo0CKnkYk7a7KT77EWv0Kkq+VHmOtqX3a2
hhX+b6a6ve9rzJ1qZYGj+obv/C3Sx1LzUjAfqVy7RJDf2uAoP5t2g8u/TkSpUxhM
VEjZBkSxYZhMyzQM6t8IgkUfnSrIPTHixbDWARZ4beMOBjxyPZK1nP7OOrNR3TkK
JtwLMQAabURCDnL0PjS0iwBTU4jtumBD1XSULyWuoTvMljrpQr1nV1oDyOt0OLqa
KA2McWtd9PdXhC8y2EIg7TmrTlJLfHYbdmkiCYj4J49Q8HWkN/6WE+RTUwARAQAB
tD5BbnRocm9waWMgQ2xhdWRlIENvZGUgUmVsZWFzZSBTaWduaW5nIDxzZWN1cml0
eUBhbnRocm9waWMuY29tPokCUQQTAQoAOxYhBDHd3iTd+rZ59C170rqpKf8afsrO
BQJpyu9wAhsPBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJELqpKf8afsrO
l5IP/2I8X1dFy5xYczWB/coIxGjuzS/V6ByZGZZEJsbr04pmuHiFUykJqPGWGQ6q
U0YF5iEwvEkaagS5m7DzhSEf3FM3Cgafax/6d70tar9Vr1D+w6uPfxetu7u/WYJp
aolIsdh5fTrBh9zSM1Njl8FM8wG8CwZQjS33Oa7d8cwRkgdUWbt6LXgz+cTQNuBn
BgW6Ks7oZFI25dfu0ojDR+aDFJg4+4wZoyDLPvJz1SIrJ5WFGs67zsx9SfS3yZnf
XKmBe+f0dUy+GJ2nFZrXFf99+c0dPEHYO8DCeAHZizjkFrdYtUHdDU0YDYEGkLJa
bE+pgcpkHf5EvsZzHsyDbl95W/eh7pcXMbwkN+W4CBYUE9X4uHhqzWaC5yAVRWUA
1BJ9V4LjZfHPLEJt0I3TxzXiEg9/BVeaTYq9RjaxIFo9Nfk158HqJY6SA5jslBlx
Gv/No8u+xVcze2UJyGVfEIUfm92+0UAIkny3+5cuVV0ICzJxXlXj0CnLM9Lt50wE
p3suVwuBEviCbZ08eAH1Ht8gbBdSsiOkIU8CX3v/scwHHx5q0+NBL6xLrQObg13a
tRXBlKObfElkPN3lTUbUnJOW4U8uSjH8VRP+AujKWMDFe7x0zCs+iYY1mTOvbrTS
9n3CmZUmbynZ+E/QWNENpW/pDNZdWFy43PASmML5FHu4m9Sn
=oqMI
-----END PGP PUBLIC KEY BLOCK-----`;

const HASHES: Record<number, string> = { 8: "sha256", 9: "sha384", 10: "sha512" };
const invalid = (message: string) => new AgentError("PROVIDER_SIGNATURE_INVALID", message);

function dearmor(text: string): Buffer {
  const lines = text.replace(/\r/g, "").split("\n");
  const start = lines.findIndex(line => line.startsWith("-----BEGIN PGP"));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("-----END PGP"));
  if (start < 0 || end < 0) throw invalid("Invalid OpenPGP armor");
  const body = lines.slice(start + 1, end);
  const blank = body.findIndex(line => line.trim() === "");
  // Armor headers end at the first blank line; the optional CRC-24 line starts with "=".
  const data = body.slice(blank + 1).filter(line => !line.startsWith("=")).join("").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length === 0) throw invalid("Invalid OpenPGP armor");
  return Buffer.from(data, "base64");
}

function* packets(buffer: Buffer): Generator<{ tag: number; body: Buffer }> {
  let index = 0;
  while (index < buffer.length) {
    const header = buffer[index++]!;
    if (!(header & 0x80)) throw invalid("Invalid OpenPGP packet");
    let tag: number; let length: number;
    if (header & 0x40) {
      tag = header & 0x3f;
      const first = buffer[index++];
      if (first === undefined) throw invalid("Truncated OpenPGP packet");
      if (first < 192) length = first;
      else if (first < 224) { length = ((first - 192) << 8) + (buffer[index++] ?? 0) + 192; }
      else if (first === 255) { if (index + 4 > buffer.length) throw invalid("Truncated OpenPGP packet"); length = buffer.readUInt32BE(index); index += 4; }
      else throw invalid("Unsupported partial-length packet");
    } else {
      tag = (header >> 2) & 0x0f;
      const kind = header & 3;
      if (kind === 0) length = buffer[index++] ?? 0;
      else if (kind === 1) { if (index + 2 > buffer.length) throw invalid("Truncated OpenPGP packet"); length = buffer.readUInt16BE(index); index += 2; }
      else if (kind === 2) { if (index + 4 > buffer.length) throw invalid("Truncated OpenPGP packet"); length = buffer.readUInt32BE(index); index += 4; }
      else throw invalid("Unsupported indeterminate-length packet");
    }
    if (index + length > buffer.length) throw invalid("Truncated OpenPGP packet");
    yield { tag, body: buffer.subarray(index, index + length) };
    index += length;
  }
}

function mpi(buffer: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 2 > buffer.length) throw invalid("Truncated OpenPGP integer");
  const bytes = (buffer.readUInt16BE(offset) + 7) >> 3;
  if (bytes === 0 || offset + 2 + bytes > buffer.length) throw invalid("Invalid OpenPGP integer");
  return { value: buffer.subarray(offset + 2, offset + 2 + bytes), next: offset + 2 + bytes };
}

function publicKey(armored: string, fingerprint: string) {
  const first = [...packets(dearmor(armored))].find(packet => packet.tag === 6);
  if (!first || first.body[0] !== 4 || first.body[5] !== 1) throw invalid("Unsupported OpenPGP key");
  const header = Buffer.from([0x99, first.body.length >> 8, first.body.length & 0xff]);
  if (createHash("sha1").update(header).update(first.body).digest("hex").toUpperCase() !== fingerprint.toUpperCase()) throw invalid("Release key fingerprint mismatch");
  const n = mpi(first.body, 6); const e = mpi(first.body, n.next);
  return { key: createPublicKey({ key: { kty: "RSA", n: n.value.toString("base64url"), e: e.value.toString("base64url") }, format: "jwk" }), size: n.value.length };
}

function issuerFingerprint(hashed: Buffer): string | undefined {
  let index = 0;
  while (index < hashed.length) {
    let length = hashed[index++]!;
    if (length >= 192 && length < 255) length = ((length - 192) << 8) + (hashed[index++] ?? 0) + 192;
    else if (length === 255) { if (index + 4 > hashed.length) throw invalid("Invalid signature subpacket"); length = hashed.readUInt32BE(index); index += 4; }
    if (length < 1 || index + length > hashed.length) throw invalid("Invalid signature subpacket");
    if ((hashed[index]! & 0x7f) === 33 && hashed[index + 1] === 4 && length === 22) return hashed.subarray(index + 2, index + 22).toString("hex").toUpperCase();
    index += length;
  }
  return undefined;
}

/** Throws unless `armoredSignature` is a valid detached signature of `data` made by the pinned key. */
export function verifyDetachedSignature(data: Buffer | string, armoredSignature: string, armoredKey = CLAUDE_RELEASE_PUBLIC_KEY, fingerprint = CLAUDE_RELEASE_KEY_FINGERPRINT): void {
  const signature = [...packets(dearmor(armoredSignature))].find(packet => packet.tag === 2)?.body;
  if (!signature || signature.length < 10 || signature[0] !== 4 || signature[1] !== 0 || signature[2] !== 1) throw invalid("Unsupported OpenPGP signature");
  const algorithm = HASHES[signature[3]!];
  if (!algorithm) throw invalid("Unsupported OpenPGP hash");
  const hashedEnd = 6 + signature.readUInt16BE(4);
  if (hashedEnd + 2 > signature.length) throw invalid("Truncated OpenPGP signature");
  if (issuerFingerprint(signature.subarray(6, hashedEnd)) !== fingerprint.toUpperCase()) throw invalid("Signature was not made by the pinned release key");
  const unhashedEnd = hashedEnd + 2 + signature.readUInt16BE(hashedEnd);
  if (unhashedEnd + 2 > signature.length) throw invalid("Truncated OpenPGP signature");
  const left16 = signature.subarray(unhashedEnd, unhashedEnd + 2);
  const raw = mpi(signature, unhashedEnd + 2).value;
  const { key, size } = publicKey(armoredKey, fingerprint);
  if (raw.length > size) throw invalid("Invalid signature length");
  const trailer = Buffer.alloc(6); trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(hashedEnd, 2);
  const message = Buffer.concat([typeof data === "string" ? Buffer.from(data, "utf8") : data, signature.subarray(0, hashedEnd), trailer]);
  if (!createHash(algorithm).update(message).digest().subarray(0, 2).equals(left16)) throw invalid("Release signature does not match");
  const padded = Buffer.concat([Buffer.alloc(size - raw.length), raw]);
  if (!verify(algorithm, message, { key, padding: constants.RSA_PKCS1_PADDING }, padded)) throw invalid("Release signature does not match");
}
