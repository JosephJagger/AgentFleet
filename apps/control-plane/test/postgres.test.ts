import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrateSqliteToPostgres } from "../src/migrate-postgres.js";
import { postgresSql } from "../src/postgres-sql.js";

const file = process.env.AGENTFLEET_TEST_PG_CONFIG;
const url: string = file ? JSON.parse(readFileSync(file, "utf8")).url : "";
const schemaName = () => "af_test_" + randomBytes(16).toString("hex");
const config = () => loadConfig({ AUTH_MODE: "password", ADMIN_EMAIL: "pg@example.test", ADMIN_PASSWORD: "migration-test-password", PUBLIC_ORIGIN: "http://test.local", COOKIE_SECURE: "false" });

test("SQL compiler leaves literals intact, numbers typed, and aliases intact at references", () => {
  const sql = postgresSql("SELECT 'literal ? OR IGNORE >= json(?)' AS label, ? AS totalTokens WHERE ? >= 1 ORDER BY totalTokens", [42, 3]);
  assert.ok(sql.includes("'literal ? OR IGNORE >= json(?)'"));
  assert.ok(sql.includes('$1::bigint AS "totalTokens"'));
  assert.ok(sql.includes('$2::bigint >= 1 ORDER BY "totalTokens"'));
});

test("PostgreSQL imports exact data/row order, preserves sequences, rejects overwrite, and owns a single runtime", { skip: !url }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "af-pg-migrate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "copy.sqlite");
  const source = new ControlPlaneDatabase(path);
  const owner = source.bootstrap(config());
  const originalText = "\uFEFF中文 ? ' quoted\n🚀";
  source.run("UPDATE workspaces SET name=?", originalText);
  const audit = source.audit({ workspaceId: owner.workspaceId, action: "fixture", metadata: { boolean: true, null: null } });
  source.close();
  const schema = schemaName();
  const client = new pg.Client({ connectionString: url }); await client.connect();
  t.after(async () => { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); });
  const preflight = await migrateSqliteToPostgres({snapshot: path, url, schema, apply: false});
  assert.equal((await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).rowCount, 0);
  const result = await migrateSqliteToPostgres({ snapshot: path, url, schema, apply: true });
  assert.deepEqual(result.tables, preflight.tables);
  await assert.rejects(migrateSqliteToPostgres({ snapshot: path, url, schema, apply: true }), /already exists/);
  const db = new ControlPlaneDatabase(path, {url, schema});
  t.after(() => db.close());
  assert.equal(db.get<{name:string}>("SELECT name FROM workspaces")!.name, originalText);
  assert.equal(db.get<{audit_id:string}>("SELECT audit_id FROM audit_entries ORDER BY rowid")!.audit_id, audit);
  const next = db.audit({workspaceId: owner.workspaceId, action: "after_import"});
  assert.equal(db.get<{audit_id:string}>("SELECT audit_id FROM audit_entries ORDER BY rowid DESC")!.audit_id, next);
  assert.throws(() => new ControlPlaneDatabase(path, {url, schema}), /Another control-plane/);
  assert.throws(() => db.transaction(() => { db.run("UPDATE workspaces SET name='rollback'"); throw new Error("abort"); }), /abort/);
  assert.equal(db.get<{name:string}>("SELECT name FROM workspaces")!.name, originalText);
  assert.equal(db.get<{value:number}>("SELECT json_extract(?,'$.ok') AS value", '{"ok":true}')!.value, 1);
  assert.throws(() => db.run("INSERT INTO workspaces VALUES(?,?,?)",owner.workspaceId,"duplicate",new Date().toISOString()), /unique constraint/);
  assert.equal(db.get<{n:number}>("SELECT count(*) AS n FROM workspaces")!.n, 1);
});

test("failed PostgreSQL import rolls back the whole new schema without modifying the SQLite source", { skip: !url }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "af-pg-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory,"copy.sqlite"), source = new ControlPlaneDatabase(path);
  source.bootstrap(config()); source.run("UPDATE workspaces SET name=?", "invalid\0text"); source.close();
  const bytes = readFileSync(path), schema = schemaName();
  await assert.rejects(migrateSqliteToPostgres({snapshot:path,url,schema,apply:true}), /NUL|0x00/);
  const client = new pg.Client({connectionString:url}); await client.connect();
  try { assert.equal((await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1",[schema])).rowCount, 0); }
  finally { await client.end(); }
  assert.deepEqual(readFileSync(path),bytes);
  const invalidUtf8 = new ControlPlaneDatabase(path);
  invalidUtf8.run("UPDATE workspaces SET name=CAST(X'FF' AS TEXT)"); invalidUtf8.close();
  await assert.rejects(migrateSqliteToPostgres({snapshot:path,url,schema,apply:false}), /invalid UTF-8/);
});

test("PostgreSQL read batches preserve types/order and invalidate prefetched rows after writes or rollback", { skip: !url }, t => {
  const db = new ControlPlaneDatabase(":memory:", { url, schema: schemaName(), temporary: true });
  t.after(() => db.close());
  for (const id of ["a", "b"]) db.run("INSERT INTO workspaces VALUES(?,?,?)", id, id.toUpperCase(), new Date().toISOString());
  const batch = db.sqlite.readBatch!.bind(db.sqlite);
  assert.deepEqual(batch("SELECT workspace_id,'$1 literal ?' AS marker,? AS totalTokens FROM workspaces WHERE workspace_id>=? ORDER BY workspace_id DESC", [[1,"a"],[2,"b"]]), [
    [{ workspace_id:"b",marker:"$1 literal ?",totalTokens:1 },{ workspace_id:"a",marker:"$1 literal ?",totalTokens:1 }],
    [{ workspace_id:"b",marker:"$1 literal ?",totalTokens:2 }],
  ]);
  assert.deepEqual(batch("SELECT workspace_id FROM workspaces WHERE ? IS NULL OR workspace_id=? ORDER BY workspace_id", [[null,"a"],["present","b"]]), [
    [{workspace_id:"a"},{workspace_id:"b"}],[{workspace_id:"b"}],
  ]);
  assert.deepEqual(batch("SELECT singleton FROM agentfleet_schema WHERE singleton=?", [["1"],[null]]), [[{singleton:1}],[]]);
  assert.deepEqual(batch("SELECT 42 AS value", [[],[]]), [[{value:42}],[{value:42}]]);
  let calls = 0;
  db.sqlite.readBatch = (...args: Parameters<typeof batch>) => { calls++; return batch(...args); };
  const query = "SELECT name FROM (SELECT workspace_id AS logical_session_id,name FROM workspaces) w WHERE logical_session_id=?";
  const read = (id: string) => db.get<{name:string}>(query,id)!;
  db.withReadBatch(["a","b"], () => {
    const a = read("a"); a.name = "local mutation";
    assert.equal(read("a").name,"A"); assert.equal(read("b").name,"B"); assert.equal(calls,1);
    db.run("UPDATE workspaces SET name='updated' WHERE workspace_id='b'");
    assert.equal(read("b").name,"updated"); assert.equal(calls,2);
    assert.throws(() => db.transaction(() => {
      db.run("UPDATE workspaces SET name='uncommitted' WHERE workspace_id='b'");
      assert.equal(read("b").name,"uncommitted"); throw new Error("rollback");
    }), /rollback/);
    assert.equal(read("b").name,"updated");
  });
  db.run("UPDATE workspaces SET name='next request' WHERE workspace_id='a'");
  assert.equal(read("a").name,"next request");
});
