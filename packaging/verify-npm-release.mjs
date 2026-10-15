#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const artifact = process.argv[2];
const match = artifact && /^agentfleets-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(basename(artifact));
if (!match) throw new Error('Usage: node packaging/verify-npm-release.mjs <agentfleets-VERSION.tgz>');
const version = match[1];
const expected = await readFile(artifact);
const digest = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const get = async url => {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
  return response;
};
const metadata = await (await get(`https://registry.npmjs.org/agentfleets/${version}`)).json();
if (metadata.name !== 'agentfleets' || metadata.version !== version || metadata.dist?.integrity !== digest(expected)) {
  throw new Error('Published npm metadata differs from the tested artifact');
}
const url = new URL(metadata.dist.tarball);
if (url.origin !== 'https://registry.npmjs.org' || !url.pathname.startsWith('/agentfleets/-/') || url.search || url.hash || url.username || url.password) {
  throw new Error('Unexpected npm tarball location');
}
const actual = Buffer.from(await (await get(url)).arrayBuffer());
if (!actual.equals(expected)) throw new Error('Published npm tarball differs from the tested artifact');
console.log(`PASS npm agentfleets@${version}: published integrity and tarball bytes match the tested artifact`);
