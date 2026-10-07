#!/usr/bin/env node
// Read-only release gate: verify the public routes, not just container files.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
if (!process.argv[2]) throw new Error("Usage: node packaging/verify-published-installers.mjs <public-origin> [version]");
const origin = new URL(process.argv[2]);
if (origin.username || origin.password || origin.search || origin.hash) throw new Error("Use a public origin without credentials or query parameters");
const expected = process.argv[3] ?? JSON.parse(await readFile(new URL("../apps/local-agent/package.json", import.meta.url), "utf8")).version;
async function get(path) {
  const response = await fetch(new URL(path, origin), {redirect:"error",cache:"no-store",signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [route, file] of [["/install","install.sh"],["/install-macos","install-macos.sh"],["/install.ps1","install.ps1"]]) {
  const actual = await get(route), local = await readFile(new URL(file, import.meta.url));
  if (digest(actual) !== digest(local)) throw new Error(`${route}: public installer differs from this checkout; check reverse proxy aliases and caches`);
  console.log(`PASS ${route}: public bytes match verified installer`);
}
const manifest = JSON.parse((await get("/downloads/manifest.json")).toString("utf8"));
if (manifest.schemaVersion !== 1 || manifest.version !== expected) throw new Error("Published manifest version differs from expected release");
for (const platform of ["linux-x64","darwin-arm64","darwin-x64","win32-x64"]) {
  const artifact = manifest.artifacts?.[platform];
  if (!artifact || artifact.file !== `agentfleet-${platform}-${expected}.tar.gz` || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid artifact for ${platform}`);
  const checksum = (await get(`/downloads/${artifact.file}.sha256`)).toString("utf8").trim().split(/\s+/);
  if (checksum[0] !== artifact.sha256 || checksum[1] !== artifact.file) throw new Error(`Published checksum mismatch for ${platform}`);
  console.log(`PASS ${platform}: immutable checksum route matches manifest`);
}
console.log(`PASS public release ${expected}`);
