import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeDownloads } from './merge-release-downloads.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-downloads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old'), incoming = join(root, 'new');
  await mkdir(old); await mkdir(incoming);
  return { old, incoming };
}
test('preserves old downloads, accepts identical artifacts and updates manifests', async t => {
  const {old, incoming} = await fixture(t);
  await writeFile(join(old, 'agent-146.tar.gz'), 'old bytes');
  await writeFile(join(old, 'codex-154.tar.gz'), 'same bytes');
  await writeFile(join(old, 'manifest.json'), 'old manifest');
  await writeFile(join(incoming, 'manifest.json'), 'new manifest');
  await writeFile(join(incoming, 'agent-147.tar.gz'), 'new bytes');
  await writeFile(join(incoming, 'codex-154.tar.gz'), 'same bytes');
  await mergeDownloads(old, incoming);
  assert.equal(await readFile(join(old, 'agent-146.tar.gz'), 'utf8'), 'old bytes');
  assert.equal(await readFile(join(old, 'agent-147.tar.gz'), 'utf8'), 'new bytes');
  assert.equal(await readFile(join(old, 'manifest.json'), 'utf8'), 'new manifest');
});
test('rejects changed immutable bytes before changing manifests', async t => {
  const {old, incoming} = await fixture(t);
  await writeFile(join(old, 'manifest.json'), 'old manifest');
  await writeFile(join(old, 'z-agent-146.tar.gz'), 'old bytes');
  await writeFile(join(incoming, 'manifest.json'), 'new manifest');
  await writeFile(join(incoming, 'z-agent-146.tar.gz'), 'different bytes');
  await assert.rejects(mergeDownloads(old, incoming), /Immutable release artifact differs/);
  assert.equal(await readFile(join(old, 'manifest.json'), 'utf8'), 'old manifest');
});
test('rejects symlink destinations', async t => {
  const {old, incoming} = await fixture(t);
  await writeFile(join(old, 'target'), 'untouched');
  await symlink('target', join(old, 'manifest.json'));
  await writeFile(join(incoming, 'manifest.json'), 'new');
  await assert.rejects(mergeDownloads(old, incoming), /not a regular file/);
  assert.equal(await readFile(join(old, 'target'), 'utf8'), 'untouched');
});
