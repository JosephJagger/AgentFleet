import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const corpus = await read('../src/writing-corpus.json');
const glossary = await read('../src/writing-glossary.json');
const taxonomy = await read('../src/writing-taxonomy.json');
const translations = await read('../../web/src/i18n/en.json');
const categories = new Map(taxonomy.domains.flatMap(domain => domain.categories.map(category => [category.id, domain.id])));
const ids = new Set();
for (const entry of [...glossary.entries, ...corpus.intents]) {
  assert(entry.id && !ids.has(entry.id), `Missing or duplicate ID: ${entry.id}`);
  ids.add(entry.id);
  assert.equal(categories.get(entry.category), entry.domain, `Invalid category: ${entry.id}`);
  for (const domain of entry.relatedDomains ?? []) assert(taxonomy.domains.some(item => item.id === domain), `Unknown related domain: ${entry.id}`);
  assert(entry.source && entry.license, `Missing provenance: ${entry.id}`);
  assert(entry.terms.zh && entry.terms.en, `Missing bilingual term: ${entry.id}`);
  const detail = entry.definitions ?? entry.goals;
  assert.equal(translations[detail.zh], detail.en, `Missing or inconsistent translation: ${entry.id}`);
}
const concepts = new Map(glossary.entries.map(entry => [entry.id, entry]));
for (const intent of corpus.intents) if (intent.conceptId) assert(concepts.has(intent.conceptId), `Unknown concept: ${intent.id}`);
// Chinese descriptions are i18n source keys; term language never selects the interface language.
const terms = corpus.intents.flatMap(intent => ['zh','en'].map(language => ({
  id: intent.conceptId ?? intent.id, domain: intent.domain, category: intent.category,
  label: intent.terms[language], detail: intent.goals.zh, aliases: [intent.terms[language]],
})));
for (const entry of glossary.entries) for (const language of ['zh','en']) {
  const label = entry.terms[language];
  const existing = terms.find(term => term.label.toLowerCase() === label.toLowerCase());
  if (existing) {
    // A rewrite can reference a concept, but must not discard that concept's aliases or definition.
    assert.equal(existing.id, entry.id, `Unlinked duplicate concept: ${label}`);
    Object.assign(existing, {domain:entry.domain, category:entry.category, detail:entry.definitions.zh});
    existing.aliases = [...new Set([...existing.aliases, ...entry.aliases[language]])];
  } else terms.push({id:entry.id,domain:entry.domain,category:entry.category,label,detail:entry.definitions.zh,aliases:[label,...entry.aliases[language]]});
}
await writeFile(new URL('../../web/src/lib/domain-terms.generated.json',import.meta.url), JSON.stringify(terms,null,2)+'\n');
const rewrites = corpus.intents.filter(intent => ['philosophy','cognition','ai','agent','ecommerce','analytics','operations','marketing','finance'].includes(intent.domain) || ['video-j-cut','video-l-cut','video-ducking','video-speed-ramp','video-subtitle-timing'].includes(intent.id)).map(intent => ({id:intent.id,domain:intent.domain,category:intent.category,examples:intent.examples,goals:intent.goals}));
await writeFile(new URL('../../web/src/lib/domain-rewrites.generated.json',import.meta.url), JSON.stringify(rewrites,null,2)+'\n');
