import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ControlPlaneDatabase as Database } from "../src/db.js";
export type { DbRow } from "../src/db.js";

/** Replay existing behavioral tests against an isolated PostgreSQL schema per fixture.
 * Disk-backed fixtures exercise historical SQLite migrations and stay on SQLite.
 */
export class ControlPlaneDatabase extends Database {
  constructor(path: string) {
    const file = process.env.AGENTFLEET_TEST_PG_CONFIG;
    const url: string | undefined = file ? JSON.parse(readFileSync(file, "utf8")).url : undefined;
    super(path === ":sqlite-memory:" ? ":memory:" : path, url && path === ":memory:" ? { url, schema: `af_test_${randomBytes(16).toString("hex")}`, temporary: true } : undefined);
  }
}

export function rejectInsert(db: Database, table: string, trigger: string, message: string) {
  if (db.backend === "postgresql") {
    db.sqlite.exec(`CREATE FUNCTION ${trigger}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}_fn()`);
  } else db.sqlite.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'${message}'); END;`);
  return () => db.sqlite.exec(db.backend === "postgresql" ? `DROP TRIGGER ${trigger} ON ${table}; DROP FUNCTION ${trigger}_fn()` : `DROP TRIGGER ${trigger}`);
}
