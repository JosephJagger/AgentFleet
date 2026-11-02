import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneDatabase } from '../src/db.js';

for (const key of ['event_id', 'command_id'] as const) test(`${key} read batches keep scope, ordering, isolation and invalidation`, t => {
  const db = new ControlPlaneDatabase(':memory:'); t.after(() => db.close());
  db.sqlite.exec(`CREATE TABLE batch_fixture(${key} TEXT, workspace_id TEXT, value TEXT)`);
  for(const id of ['a','b']) for(const scope of ['mine','other']) db.run(`INSERT INTO batch_fixture VALUES(?,?,?)`,id,scope,scope+'-'+id);
  let batches=0;
  db.sqlite.readBatch=(sql,sets)=>{batches++;return sets.map(values=>db.sqlite.prepare(sql).all(...values));};
  const sql=`SELECT value FROM batch_fixture WHERE ${key}=? AND workspace_id=?`;
  db.withReadBatch(['a','b'],()=>{
    const row=db.get<{value:string}>(sql,'a','mine')!;row.value='changed outside cache';
    assert.equal(db.get<{value:string}>(sql,'b','mine')!.value,'mine-b');
    assert.equal(db.get<{value:string}>(sql,'a','mine')!.value,'mine-a');
    assert.equal(batches,1);
    assert.equal(db.get<{value:string}>(sql,'a','other')!.value,'other-a');
    assert.equal(batches,2);
    db.run(`UPDATE batch_fixture SET value='new' WHERE ${key}='b' AND workspace_id='mine'`);
    assert.equal(db.get<{value:string}>(sql,'b','mine')!.value,'new');
  },[],key);
  db.run(`UPDATE batch_fixture SET value='later' WHERE ${key}='a' AND workspace_id='mine'`);
  assert.equal(db.get<{value:string}>(sql,'a','mine')!.value,'later');
});
