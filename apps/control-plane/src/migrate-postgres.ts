import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { baseline, migratePostgres } from "./postgres-schema.js";

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
async function fileHash(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
interface Column { name: string; type: string; pk: number }
interface TableProof { table: string; rows: number; sha256: string }

/** Offline copy only: never changes the SQLite source or an existing PostgreSQL schema. */
export async function migrateSqliteToPostgres(input: { snapshot: string; url: string; schema: string; apply: boolean;
  progress?: (proof: TableProof) => void }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.schema) || ["public", "information_schema"].includes(input.schema) || input.schema.startsWith("pg_")) throw new Error("Use a new, dedicated target schema");
  const sqlite = new DatabaseSync(input.snapshot, { readOnly: true });
  const client = new pg.Client({ connectionString: input.url, application_name: "agentfleets-offline-migration", connectionTimeoutMillis: 10_000 });
  let connected = false;
  try {
    sqlite.exec("BEGIN");
    if (sqlite.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("Snapshot integrity check failed");
    if (sqlite.prepare("PRAGMA foreign_key_check").get()) throw new Error("Snapshot contains foreign-key violations");
    if (sqlite.prepare("PRAGMA user_version").get()?.user_version !== baseline.sqliteVersion) throw new Error("Snapshot schema version differs from the PostgreSQL baseline; upgrade a separate copy first");
    const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r => r.name);
    if (JSON.stringify(names) !== JSON.stringify(baseline.tables)) throw new Error("Snapshot table inventory differs from the baseline");
    const sourceSha256 = await fileHash(input.snapshot);
    const sourceProof: TableProof[] = [];
    if (input.apply) {
      await client.connect(); connected = true;
      await client.query("BEGIN");
      // CREATE SCHEMA (without IF NOT EXISTS) is the overwrite protection, including under races.
      await client.query(`CREATE SCHEMA ${quote(input.schema)}`);
      await client.query(`SET LOCAL search_path TO ${quote(input.schema)}`);
      await migratePostgres(client, false);
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      // A source publication fence must be preserved, without blocking insertion of existing calls.
      for (const table of ["panel_voice_calls", "voice_sessions"]) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_deployment_guard`);
    }
    for (const table of names) {
      const columns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all() as unknown as Column[];
      if (baseline.rowidTables.includes(table)) columns.push({name: "rowid", type: "INTEGER", pk: 0});
      let keys = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => quote(c.name));
      if (!keys.length) {
        const indexes = sqlite.prepare(`PRAGMA index_list(${quote(table)})`).all() as unknown as { name: string; unique: number; partial: number }[];
        const unique = indexes.find(index => index.unique && !index.partial);
        if (!unique) throw new Error(`Table has no stable unique key: ${table}`);
        keys = (sqlite.prepare(`PRAGMA index_info(${quote(unique.name)})`).all() as unknown as {name: string}[]).map(c => quote(c.name));
      }
      const selection = columns.map(c => quote(c.name)).join(",");
      const query = `SELECT ${selection} FROM ${quote(table)} ORDER BY ${keys.join(",")}`;
      // node:sqlite's text reader can truncate NULs or replace invalid UTF-8.
      // Read the original bytes and decode strictly before hashing or importing.
      const sourceSelection = columns.map(c => c.type === "TEXT" ? `CAST(${quote(c.name)} AS BLOB) AS ${quote(c.name)}` : quote(c.name)).join(",");
      const source = sqlite.prepare(`SELECT ${sourceSelection} FROM ${quote(table)} ORDER BY ${keys.join(",")}`); source.setReadBigInts(true);
      const digest = createHash("sha256"); let count = 0;
      let batch: unknown[][] = [], batchBytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const canonical = (row: Record<string, unknown>) => columns.map(c => {
        const value = row[c.name];
        if (value == null) return null;
        if (c.type === "INTEGER") return String(value);
        if (value instanceof Uint8Array) {
          try { return decoder.decode(value); }
          catch { throw new Error(`Snapshot contains invalid UTF-8 text: ${table}`); }
        }
        return value;
      });
      const flush = async () => {
        if (!batch.length) return;
        const parameters = batch.flat();
        const placeholders = batch.map((_, i) => "(" + columns.map((__, j) => `$${i * columns.length + j + 1}`).join(",") + ")").join(",");
        await client.query(`INSERT INTO ${quote(table)}(${selection}) VALUES ${placeholders}`, parameters);
        batch = []; batchBytes = 0;
      };
      for (const row of source.iterate()) {
        const values = canonical(row), encoded = JSON.stringify(values) + "\n";
        if (values.some(value => typeof value === "string" && value.includes("\0"))) throw new Error(`PostgreSQL cannot store a NUL byte in text: ${table}`);
        digest.update(encoded); count++;
        if (input.apply) {
          batch.push(values); batchBytes += Buffer.byteLength(encoded);
          if (batch.length >= 200 || batchBytes >= 2 * 1024 * 1024) await flush();
        }
      }
      if (input.apply) await flush();
      const proof = { table, rows: count, sha256: digest.digest("hex") };
      if (input.apply) {
        const targetDigest = createHash("sha256"); let targetCount = 0;
        await client.query(`DECLARE af_verify NO SCROLL CURSOR FOR ${query}`);
        for (;;) {
          const result = await client.query("FETCH 500 FROM af_verify");
          if (!result.rows.length) break;
          for (const row of result.rows) { targetDigest.update(JSON.stringify(canonical(row)) + "\n"); targetCount++; }
        }
        await client.query("CLOSE af_verify");
        if (targetCount !== count || targetDigest.digest("hex") !== proof.sha256) throw new Error(`Content verification failed for table ${table}`);
      }
      sourceProof.push(proof); input.progress?.(proof);
    }
    if (sourceSha256 !== await fileHash(input.snapshot)) throw new Error("Snapshot file changed during migration");
    if (input.apply) {
      // Fresh bulk-loaded tables otherwise have no planner statistics. Collect
      // them before the first service startup, including correlated history reads.
      for (const table of names) await client.query(`ANALYZE ${quote(table)}`);
      for (const { table, column } of baseline.identityColumns) {
        // Never restart a sequence below a deleted SQLite AUTOINCREMENT high-water mark.
        const high = column === "rowid" ? 0 : sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").get(table)?.seq ?? 0;
        await client.query(`SELECT setval(pg_get_serial_sequence($1,$2),greatest(coalesce(max(${quote(column)}),0),$3,1),greatest(coalesce(max(${quote(column)}),0),$3)>0) FROM ${quote(table)}`, [table, column, String(high)]);
      }
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      for (const table of ["panel_voice_calls", "voice_sessions"]) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_deployment_guard`);
      await client.query("COMMIT");
    }
    return { applied: input.apply, sourceSha256, sqliteVersion: baseline.sqliteVersion, postgresVersion: baseline.version, schema: input.schema, tables: sourceProof };
  } catch (error) {
    if (connected) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    sqlite.close();
    if (connected) await client.end();
  }
}
