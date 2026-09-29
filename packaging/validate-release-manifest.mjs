#!/usr/bin/env node
// Exercise the actual dependency-free installer parsers before publication.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const path = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(path, "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.match(manifest.version, /^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/);
for (const [platform, artifact] of Object.entries(manifest.artifacts)) {
  if (platform === "win32-x64") continue; // Windows uses ConvertFrom-Json.
  const mac = platform.startsWith("darwin-");
  const source = readFileSync(new URL(mac ? "install-macos.sh" : "install.sh", import.meta.url), "utf8");
  const start = source.indexOf("COMPACT=$(", source.indexOf('MANIFEST="$TEMP_DIR/manifest.json"'));
  const end = source.indexOf(mac ? 'ARTIFACT="$TEMP_DIR/$FILE"' : 'if [ "$SCHEMA_VERSION"', start);
  assert.ok(start >= 0 && end > start);
  const field = mac ? source.split("\n").find(line => line.startsWith("field()")) + "\n" : "";
  const script = 'set -eu\n' + field + source.slice(start, end) + '\nprintf "%s\\n" "$VERSION" "$FILE" "$SHA256" "$SIZE"\n';
  const output = execFileSync("/bin/sh", ["-c", script], {
    env: { ...process.env, MANIFEST: path, PLATFORM: platform }, encoding: "utf8",
  }).trim().split("\n");
  assert.deepEqual(output, [manifest.version, artifact.file, artifact.sha256, String(artifact.size)], `${platform}: installer cannot read release manifest`);
}
console.log(`Installer manifest validation passed: ${manifest.version}`);
