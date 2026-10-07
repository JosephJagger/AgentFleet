import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { reorderQueue } from "../src/queue-order.js";
import type { ControlPlaneDatabase } from "../src/db.js";
import type { Principal } from "../src/auth.js";

test("queue reorder is atomic, workspace scoped and rejects stale or changed membership", t => {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(`CREATE TABLE logical_sessions(logical_session_id TEXT PRIMARY KEY,workspace_id TEXT,queue_version INTEGER,updated_at TEXT);
    CREATE TABLE turn_queue(queue_item_id TEXT PRIMARY KEY,logical_session_id TEXT,position INTEGER,state TEXT,updated_at TEXT,UNIQUE(logical_session_id,position));
    INSERT INTO logical_sessions VALUES('s','w',3,'');
    INSERT INTO turn_queue VALUES('a','s',1,'queued',''),('b','s',2,'queued',''),('c','s',3,'dispatching','');`);
  const audit: unknown[] = [];
  const db = { get: (s: string, ...args: string[]) => sql.prepare(s).get(...args), all: (s: string, ...args: string[]) => sql.prepare(s).all(...args), run: (s: string, ...args: (string | number)[]) => sql.prepare(s).run(...args), audit: (v: unknown) => audit.push(v), transaction: (fn: () => unknown) => { sql.exec("BEGIN"); try { const r = fn(); sql.exec("COMMIT"); return r; } catch(e) { sql.exec("ROLLBACK"); throw e; } } } as unknown as ControlPlaneDatabase;
  const principal = { workspaceId: "w", userId: "u", clientSessionId: "client" } as Principal;
  assert.throws(() => reorderQueue(db, { ...principal, workspaceId: "other" }, "s", { queueVersion: 3, ids: ["b", "a"] }), /not found/);
  assert.throws(() => reorderQueue(db, principal, "s", { queueVersion: 2, ids: ["b", "a"] }), /变化/);
  assert.throws(() => reorderQueue(db, principal, "s", { queueVersion: 3, ids: ["b", "c"] }), /变化/);
  assert.deepEqual(reorderQueue(db, principal, "s", { queueVersion: 3, ids: ["b", "a"] }), { queueVersion: 4 });
  assert.deepEqual(sql.prepare("SELECT queue_item_id FROM turn_queue ORDER BY position").all().map(r => r.queue_item_id), ["b", "a", "c"]);
  assert.equal(audit.length, 1);
});
