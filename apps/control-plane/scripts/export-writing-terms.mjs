import { readFile, writeFile } from 'node:fs/promises';
const corpus = JSON.parse(await readFile(new URL('../src/writing-corpus.json', import.meta.url),'utf8'));
// Details are Chinese i18n source keys for both term languages; the UI translates them.
const terms = corpus.intents.flatMap(intent => ['zh','en'].map(language => ({label:intent.terms[language],detail:intent.goals.zh,aliases:[intent.terms[language]]})));
const glossary = JSON.parse(await readFile(new URL('../src/writing-glossary.json', import.meta.url),'utf8'));
for (const entry of glossary.entries) for (const language of ['zh','en']) {
  const label = entry.terms[language];
  if (!terms.some(term => term.label.toLowerCase() === label.toLowerCase())) terms.push({label,detail:entry.definitions.zh,aliases:[label,...entry.aliases[language]]});
}
await writeFile(new URL('../../web/src/lib/domain-terms.generated.json',import.meta.url), JSON.stringify(terms,null,2)+'\n');

const rewrites = corpus.intents.filter(intent => ['philosophy','cognition'].includes(intent.domain) || ['video-j-cut','video-l-cut','video-ducking','video-speed-ramp','video-subtitle-timing'].includes(intent.id)).map(intent => ({examples:intent.examples,goals:intent.goals}));
await writeFile(new URL('../../web/src/lib/domain-rewrites.generated.json',import.meta.url), JSON.stringify(rewrites,null,2)+'\n');
