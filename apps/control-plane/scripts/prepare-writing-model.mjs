// Build-time download only. Runtime uses local files and cannot fetch model weights.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const revision = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const root = resolve(process.argv[2] || '.writing-model');
const manifest = JSON.parse(await readFile(new URL('./writing-model-manifest.json', import.meta.url),'utf8'));
for (const [name, expected] of Object.entries(manifest)) {
  const response = await fetch(`https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/${revision}/${name}`, {signal: AbortSignal.timeout(300000)});
  if (!response.ok) throw new Error(`Model download failed: ${name} (${response.status})`);
  const path = resolve(root, name); await mkdir(dirname(path), {recursive:true});
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Model checksum mismatch: ${name}`);
  await writeFile(path, bytes);
  console.log(`Downloaded ${name}`);
}
await writeFile(resolve(root,'PROVENANCE.json'), JSON.stringify({model:'Xenova/paraphrase-multilingual-MiniLM-L12-v2',revision,license:'Apache-2.0'}));

await copyFile(new URL('./writing-model-LICENSE.txt', import.meta.url),resolve(root,'LICENSE.txt'));
