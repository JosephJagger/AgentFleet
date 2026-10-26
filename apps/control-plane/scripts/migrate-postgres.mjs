import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { migrateSqliteToPostgres } from '../dist/src/migrate-postgres.js';

const { values } = parseArgs({ options: {
  snapshot: { type: 'string' }, 'connection-file': { type: 'string' }, schema: { type: 'string' },
  report: { type: 'string' }, apply: { type: 'boolean', default: false },
}});
try {
  if (!values.snapshot || !values['connection-file'] || !values.schema || !values.report) throw new Error('Usage: --snapshot COPY.sqlite --connection-file private.json --schema NEW_SCHEMA --report report.json [--apply]');
  if (existsSync(values.report)) throw new Error('Report already exists; refusing to overwrite it');
  const file = values['connection-file'];
  if (statSync(file).mode & 0o077) throw new Error('Connection file must have mode 0600');
  const { url } = JSON.parse(readFileSync(file, 'utf8'));
  const result = await migrateSqliteToPostgres({ snapshot: values.snapshot, url, schema: values.schema, apply: values.apply,
    progress: ({ table, rows }) => console.log(JSON.stringify({ table, rows })) });
  writeFileSync(values.report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ applied: result.applied, tables: result.tables.length, rows: result.tables.reduce((n, t) => n + t.rows, 0), report: values.report }));
} catch (error) {
  // PostgreSQL errors may include row values in DETAIL. Print only the bounded error message.
  console.error(error.message); process.exitCode = 1;
}
