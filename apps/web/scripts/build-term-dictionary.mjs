import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@cspell/dict-software-terms'));
const files = ['softwareTerms.txt.gz', 'software-tools.txt', 'networkingTerms.txt', 'webServices.txt', 'computing-acronyms.txt'];
const terms = new Map();
for (const file of files) {
  const bytes = readFileSync(join(root, 'dict', file));
  const text = (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    const term = line.trim();
    // CSpell directives, compound markers, prose and tiny fragments are not suggestions.
    if (/^[A-Za-z][A-Za-z0-9.+#-]{2,39}$/.test(term)) terms.set(term.toLowerCase(), term);
  }
}
writeFileSync(new URL('../src/lib/software-terms.generated.json', import.meta.url), JSON.stringify([...terms.values()].sort()) + '\n');
writeFileSync(new URL('../public/software-terms-LICENSE.txt', import.meta.url), readFileSync(join(root, 'LICENSE')));
console.log(`Prepared ${terms.size} CSpell software terms`);
