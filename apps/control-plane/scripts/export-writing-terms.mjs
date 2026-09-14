import { readFile, writeFile } from 'node:fs/promises';
const corpus = JSON.parse(await readFile(new URL('../src/writing-corpus.json', import.meta.url),'utf8'));
const terms = corpus.intents.flatMap(intent => ['zh','en'].map(language => ({label:intent.terms[language],detail:intent.goals[language],aliases:[intent.terms[language]]})));
await writeFile(new URL('../../web/src/lib/domain-terms.generated.json',import.meta.url), JSON.stringify(terms,null,2)+'\n');
