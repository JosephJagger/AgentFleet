import test from 'node:test';
import assert from 'node:assert/strict';
import { MachineUpdates } from '../src/machine-updates.js';
import type { MachineSummary } from '../src/api-schema.js';

const machine = () => ({ machineId:'host', name:'host', lastHeartbeatAt:'1', reachability:'online',
  codexCatalog:{models:[{id:'model',description:'x'.repeat(60_000)}]},
  discovery:{agentRuntimes:{claude:{installed:true},grok:{installed:true}}} }) as unknown as MachineSummary;
function stream(compact = true) {
  const frames: any[] = [];
  return { frames, updates: new MachineUpdates(compact, frame => { frames.push(frame); return true; }) };
}
test('replayed state sends nothing; heartbeat deltas exclude catalogs and discovery', () => {
  const {frames,updates}=stream(); const value=machine(); updates.publish(value);
  for(let i=0;i<100;i++)updates.publish(machine());
  assert.equal(frames.length,1);
  for(let i=2;i<100;i++)updates.publish({...value,lastHeartbeatAt:String(i)});
  assert.equal(frames[1].type,'machine.patch');
  assert.deepEqual(frames[1].changes,{lastHeartbeatAt:'2'});
  assert.ok(Buffer.byteLength(JSON.stringify(frames.slice(1)))<15_000);
});
test('legacy pages keep full snapshots, bounded heartbeat refresh and immediate real changes', () => {
  const {frames,updates}=stream(false); const value=machine();updates.publish(value,0);
  updates.publish({...value,lastHeartbeatAt:'2'},10_000); assert.equal(frames.length,1);
  updates.publish({...value,lastHeartbeatAt:'3'},60_000); assert.equal(frames.length,2);
  updates.publish({...value,reachability:'offline'},60_001);
  assert.equal(frames[2].machine.reachability,'offline');assert.ok(frames.every(f=>f.type==='machine.changed'));
});
test('hidden tabs keep only affected ids; resume sends latest state without intermediate frames', () => {
  const {frames,updates}=stream();updates.publish(machine());updates.visible=false;
  for(let i=0;i<100;i++)updates.publish({...machine(),lastHeartbeatAt:String(i),capacity:'busy'});
  assert.equal(frames.length,1);assert.deepEqual([...updates.pending],['host']);
  updates.visible=true;updates.pending.clear();updates.publish({...machine(),lastHeartbeatAt:'100',capacity:'idle'});
  assert.equal(frames.length,2);assert.equal(frames[1].changes.capacity,'idle');
});
test('separate sockets and reconnects each establish their own full baseline', () => {
  const a=stream(),b=stream();a.updates.publish(machine());a.updates.publish({...machine(),name:'new'});
  b.updates.publish({...machine(),name:'new'});assert.equal(b.frames[0].type,'machine.changed');
  assert.equal(a.frames[1].type,'machine.patch');
});
test('cleared and removed optional fields survive delta encoding and source mutation', () => {
  const {frames,updates}=stream();const value=machine();updates.publish(value);
  value.codexCatalog=null;delete value.discovery!.agentRuntimes;value.codexProfile=null;
  updates.publish({...value,maintenance:{operationId:'operation',startedAt:'now'}});
  assert.equal(frames[1].changes.codexCatalog,null);assert.deepEqual(frames[1].changes.discovery,{});
  const next={...value};delete next.codexCatalog;updates.publish(next);
  assert.ok(frames[2].removed.includes('codexCatalog'));
});
test('failed sends never advance a baseline', () => {
  const frames:any[]=[];let success=false;
  const updates=new MachineUpdates(true,frame=>{frames.push(frame);return success;});
  updates.publish(machine());success=true;updates.publish({...machine(),name:'changed'});
  assert.equal(frames[1].type,'machine.changed');
});
