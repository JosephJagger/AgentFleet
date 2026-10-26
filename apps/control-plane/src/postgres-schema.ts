import type { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import baseline from "./postgres-baseline.json" with { type: "json" };

export { baseline };
export const WRITE_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':agentfleet-write', 0))";

const FUNCTIONS = `
CREATE FUNCTION instr(value text, needle text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT strpos(value,needle) $$;
CREATE FUNCTION af_ascii_fold(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT translate(value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') $$;
CREATE FUNCTION af_now() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION af_json_path(path text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF path = '$' THEN RETURN ARRAY[]::text[]; END IF;
  IF path !~ '^\\$(\\.[A-Za-z_0-9]+|\\[[0-9]+\\])*$' THEN RAISE EXCEPTION 'Unsupported JSON path'; END IF;
  RETURN string_to_array(ltrim(replace(replace(substring(path from 2),'[','.'),']',''),'.'),'.');
END $$;
CREATE FUNCTION af_json_text(value text, path text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT value::jsonb #>> af_json_path(path) $$;
CREATE FUNCTION af_json_number(value text, path text) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE value::jsonb #>> af_json_path(path) WHEN 'true' THEN 1 WHEN 'false' THEN 0
    ELSE (value::jsonb #>> af_json_path(path))::bigint END $$;
CREATE FUNCTION af_json_type(value text, path text DEFAULT '$') RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof(value::jsonb #> af_json_path(path))
    WHEN 'string' THEN 'text' WHEN 'boolean' THEN value::jsonb #>> af_json_path(path)
    WHEN 'number' THEN CASE WHEN (value::jsonb #>> af_json_path(path)) ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
    ELSE jsonb_typeof(value::jsonb #> af_json_path(path)) END $$;
CREATE FUNCTION af_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% are immutable', replace(TG_TABLE_NAME,'_',' '); END $$;
CREATE FUNCTION af_voice_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':agentfleet-write', 0));
  IF EXISTS(SELECT 1 FROM voice_deployment_guard WHERE singleton=1) THEN RAISE EXCEPTION 'VOICE_DEPLOYMENT_WAIT'; END IF;
  RETURN NEW;
END $$;
`;

export async function migratePostgres(client: Client, ownTransaction = true): Promise<void> {
  const checksum = createHash("sha256").update(FUNCTIONS + JSON.stringify(baseline)).digest("hex");
  if (ownTransaction) await client.query("BEGIN");
  try {
    await client.query(WRITE_LOCK);
    const exists = await client.query("SELECT to_regclass('agentfleet_schema') AS name");
    if (exists.rows[0].name) {
      const rows = await client.query("SELECT version,sqlite_version,checksum FROM agentfleet_schema WHERE singleton=1");
      if (rows.rows.length !== 1 || Number(rows.rows[0].version) !== baseline.version || Number(rows.rows[0].sqlite_version) !== baseline.sqliteVersion || rows.rows[0].checksum !== checksum) {
        throw new Error("Unsupported PostgreSQL schema version; use the matching application release");
      }
    } else {
      const tables = await client.query("SELECT 1 FROM pg_tables WHERE schemaname=current_schema() LIMIT 1");
      if (tables.rowCount) throw new Error("PostgreSQL schema must be empty before initialization");
      await client.query(FUNCTIONS);
      for (const sql of baseline.statements) await client.query(sql);
      for (const table of ["commands", "dispatch_attempts", "content_tombstones"]) {
        for (const action of ["UPDATE", "DELETE"]) await client.query(`CREATE TRIGGER ${table}_immutable_${action.toLowerCase()} BEFORE ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION af_immutable()`);
      }
      for (const table of ["panel_voice_calls", "voice_sessions"]) await client.query(`CREATE TRIGGER ${table}_deployment_guard BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION af_voice_admission()`);
      await client.query("CREATE TABLE agentfleet_schema(singleton integer PRIMARY KEY CHECK(singleton=1),version integer NOT NULL,sqlite_version integer NOT NULL,checksum text NOT NULL)");
      await client.query("INSERT INTO agentfleet_schema VALUES(1,$1,$2,$3)", [baseline.version, baseline.sqliteVersion, checksum]);
      await client.query("CREATE TABLE agentfleet_database_identity(singleton integer PRIMARY KEY CHECK(singleton=1),identity text NOT NULL UNIQUE)");
      await client.query("INSERT INTO agentfleet_database_identity VALUES(1,$1)", [randomUUID()]);
    }
    if (ownTransaction) await client.query("COMMIT");
  } catch (error) {
    if (ownTransaction) await client.query("ROLLBACK");
    throw error;
  }
}
