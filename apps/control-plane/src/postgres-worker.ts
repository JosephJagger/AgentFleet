import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import pg from "pg";
import type { PostgresOptions } from "./postgres.js";
import { baseline, migratePostgres, WRITE_LOCK } from "./postgres-schema.js";
import { postgresSql } from "./postgres-sql.js";

const { options, port, signal } = workerData as { options: PostgresOptions; port: MessagePort; signal: Int32Array };
const number = (text: string) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error("Database integer exceeds JavaScript safe range");
  return value;
};
pg.types.setTypeParser(20, number);
pg.types.setTypeParser(1700, number);
pg.types.setTypeParser(16, text => text === "t" ? 1 : 0);
const client = new pg.Client({ connectionString: options.url, application_name: "agentfleets-control-plane",
  connectionTimeoutMillis: options.timeoutMs!, statement_timeout: options.timeoutMs! - 50,
  idle_in_transaction_session_timeout: 60_000 });
let transaction = false;
let failed = false;
client.on("error", () => { failed = true; });
// Reuse translation and PostgreSQL's prepared statement plans. The parameter
// signature matters because numeric binds receive explicit casts. Bound values
// are never cache keys; keep dynamic SQL from growing the cache without limit.
const statements = new Map<string, { text: string; name: string }>();
const batchNames = new Map<string, string>();
const batchTypes = new Map<string, string[]>();
async function parameterTypes(text: string): Promise<string[] | undefined> {
  const known = batchTypes.get(text);
  if (known) return known;
  if (batchTypes.size >= 512) return;
  const name = `af_batch_types_${batchTypes.size}`;
  // Ask PostgreSQL to infer parameter types exactly as it does for a single
  // query, including NULLs and strings compared with numeric columns.
  await client.query(`PREPARE ${name} AS ${text}`);
  const result = await client.query("SELECT parameter_types::text[] AS types FROM pg_prepared_statements WHERE name=$1", [name]);
  const types: string[] = result.rows[0].types;
  batchTypes.set(text, types);
  return types;
}
function prepared(sql: string, values: unknown[]) {
  const signature = values.map(value => typeof value === "bigint" || typeof value === "number" && Number.isInteger(value) ? "i" : typeof value === "number" ? "f" : "s").join("");
  const key = signature + "\n" + sql;
  let statement = statements.get(key);
  if (!statement) {
    const text = postgresSql(sql, values);
    if (statements.size >= 512) return { text };
    statement = { text, name: `af_${statements.size}` };
    statements.set(key, statement);
  }
  return statement;
}

port.on("message", async ({ action, sql, values, sets }: { action: string; sql?: string; values?: unknown[]; sets?: unknown[][] }) => {
  try {
    if (failed) throw new Error("PostgreSQL connection was lost; restart the service");
    let rows: unknown[] = [], rowCount = 0;
    if (action === "init") {
      await client.connect();
      await client.query("SET timezone='UTC'");
      const schema = options.schema ?? "public";
      if (options.temporary) await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      const exists = await client.query("SELECT current_schema() AS name");
      if (exists.rows[0].name !== schema) throw new Error("Configured PostgreSQL schema does not exist");
      // In-memory sockets and dispatch coordination still require a single control-plane process.
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':agentfleet-runtime', 0)) AS acquired");
      if (!lock.rows[0].acquired) throw new Error("Another control-plane process owns this PostgreSQL schema");
      await migratePostgres(client);
    } else if (action === "close") {
      if (transaction) await client.query("ROLLBACK");
      if (options.temporary) await client.query(`DROP SCHEMA "${options.schema}" CASCADE`);
      await client.end();
    } else if (action === "batch") {
      if (!/^SELECT\b/i.test(sql!.trim()) || !sets?.length || sets.length > 32) throw new Error("Invalid read batch");
      const parameters: unknown[] = [];
      const compiled = sets.map(set => prepared(sql!, set).text);
      // Preserve literal strings/quoted identifiers containing dollar signs.
      const parameterPattern = /'(?:''|[^'])*'|"(?:""|[^"])*"|\$(\d+)/g;
      let text: string;
      const types = sets[0]!.length && compiled.every(value => value === compiled[0]) ? await parameterTypes(compiled[0]!) : undefined;
      if (types && types.every(type => ["text","bigint","integer","smallint","double precision","real","numeric","boolean","bytea","jsonb","json"].includes(type))) {
        // One parameterized plan for all inputs, rather than planning a copy of
        // a large summary SELECT for each session.
        const columns = sets[0]!.map((_, i) => `"p${i + 1}"`);
        const inputs = sets.map((set, index) => `(${index},${set.map((value, column) => {
          parameters.push(value);
          return `$${parameters.length}::${types[column]}`;
        }).join(",")})`);
        const select = compiled[0]!.replace(parameterPattern, (match, parameter) => parameter ? `__af_input."p${parameter}"` : match);
        text = `SELECT __af_input."__af_batch_id", r.* FROM (VALUES ${inputs.join(",")}) AS __af_input("__af_batch_id",${columns.join(",")})
          CROSS JOIN LATERAL (SELECT row_number() OVER () AS "__af_batch_order", q.* FROM (${select}) AS q) AS r
          ORDER BY "__af_batch_id", "__af_batch_order"`;
      } else {
        const parts = sets.map((set, index) => {
          const offset = parameters.length;
          const select = compiled[index]!.replace(parameterPattern, (match, parameter) => parameter ? `$${Number(parameter) + offset}` : match);
          parameters.push(...set);
          return `SELECT ${index} AS "__af_batch_id", row_number() OVER () AS "__af_batch_order", q.* FROM (${select}) AS q`;
        });
        text = `SELECT * FROM (${parts.join(" UNION ALL ")}) AS batches ORDER BY "__af_batch_id", "__af_batch_order"`;
      }
      let name = batchNames.get(text);
      if (!name && batchNames.size < 128) { name = `af_batch_${batchNames.size}`; batchNames.set(text, name); }
      const result = await client.query({ text, values: parameters, ...(name ? { name } : {}) });
      const groups: unknown[][] = sets.map(() => []);
      for (const { __af_batch_id, __af_batch_order, ...row } of result.rows) groups[__af_batch_id]!.push(row);
      rows = groups; rowCount = result.rowCount ?? 0;
    } else if (/^PRAGMA user_version\s*;?$/i.test(sql!.trim())) {
      rows = [{ user_version: baseline.sqliteVersion }]; rowCount = 1;
    } else if (/^PRAGMA foreign_key_check\s*;?$/i.test(sql!.trim())) {
      // All application FKs are enforced immediately, except in the offline importer.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } else if (/^BEGIN IMMEDIATE\s*;?$/i.test(sql!.trim())) {
      await client.query("BEGIN"); transaction = true;
      await client.query(WRITE_LOCK);
    } else if (/^(COMMIT|ROLLBACK)\s*;?$/i.test(sql!.trim())) {
      await client.query(sql!); transaction = false;
    } else {
      const statement = action === "exec" ? { text: sql! } : prepared(sql!, values ?? []);
      const write = /^(INSERT|UPDATE|DELETE)\b/i.test(statement.text);
      const own = write && !transaction;
      if (own) { await client.query("BEGIN"); await client.query(WRITE_LOCK); }
      try {
        const result = await client.query({ ...statement, values: values ?? [] });
        const last = Array.isArray(result) ? result.at(-1)! : result;
        rows = last.rows; rowCount = last.rowCount ?? 0;
        if (own) await client.query("COMMIT");
      } catch (error) {
        if (own) await client.query("ROLLBACK");
        throw error;
      }
    }
    port.postMessage({ rows, rowCount });
  } catch (error) {
    const value = error as Error & { code?: string };
    // Do not expose connection strings, statement parameters or PostgreSQL DETAIL (row values).
    const message = value.message.replaceAll(options.url, "[database]");
    port.postMessage({ error: { message, code: value.code }, fatal: failed || action === "init" });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
