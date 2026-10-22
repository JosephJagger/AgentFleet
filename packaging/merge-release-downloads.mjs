// Keep published versioned URLs intact when building a new full release.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mutable = new Set(['manifest.json', 'codex-manifest.json']);
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function mergeDownloads(previous, incoming) {
  const files = await readdir(incoming, { withFileTypes: true });
  // Check all collisions before modifying even a mutable manifest.
  for (const entry of files) {
    if (!entry.isFile()) throw new Error(`Release entry must be a regular file: ${entry.name}`);
    const source = join(incoming, entry.name), target = join(previous, entry.name);
    let existing;
    try { existing = await lstat(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.isFile()) throw new Error(`Existing release entry is not a regular file: ${entry.name}`);
    if (existing && !mutable.has(entry.name) && await digest(source) !== await digest(target)) {
      throw new Error(`Immutable release artifact differs: ${entry.name}`);
    }
  }
  for (const entry of files) await copyFile(join(incoming, entry.name), join(previous, entry.name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: merge-release-downloads.mjs <previous> <incoming>');
  await mergeDownloads(process.argv[2], process.argv[3]);
}
