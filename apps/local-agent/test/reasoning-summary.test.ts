import assert from 'node:assert/strict';
import test from 'node:test';
import { ReasoningSummaries } from '../src/reasoning-summary.js';
import { CodexAppServer, type AppEvent, type AppServerCallbacks } from '../src/app-server.js';
import type { ManagedThread } from '../src/types.js';
const base = { threadId: 'thread', turnId: 'turn', itemId: 'item', summaryIndex: 0 };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: import('node:test').TestContext) {
  const events: AppEvent[] = [];
  const stream = new ReasoningSummaries(async event => { events.push(event); });
  t.after(() => stream.close());
  return { stream, events };
}
const summary = (e: AppEvent) => (e.payload.item as { summary: string[] }).summary;

test('public deltas persist as ordered snapshots, throttle updates and flush empty completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, events } = fixture(t);
  await stream.append({ ...base, delta: 'First' });
  await stream.append({ ...base, delta: ' part' });
  await stream.append({ ...base, summaryIndex: 1, delta: 'Second part' });
  assert.equal(events.length, 1);
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(summary(events[1]!), ['First part', 'Second part']);
  await stream.append({ ...base, summaryIndex: 1, delta: '.' });
  assert.equal(events.length, 2, 'cooldown continues after a scheduled flush');
  assert.deepEqual(await stream.complete('thread', 'turn', 'item', []), ['First part', 'Second part.']);
  assert.deepEqual(summary(events.at(-1)!), ['First part', 'Second part.']);
  const count = events.length;
  t.mock.timers.tick(10_000); await settle();
  await stream.append({ ...base, delta: 'late duplicate' });
  assert.equal(events.length, count);
});

test('native completed summary wins and identical item IDs remain scoped to thread and turn', async t => {
  const { stream } = fixture(t);
  await stream.append({ ...base, delta: 'partial' });
  await stream.append({ ...base, threadId: 'other', delta: 'other thread' });
  await stream.append({ ...base, turnId: 'next', delta: 'next turn' });
  assert.deepEqual(await stream.complete('thread', 'turn', 'item', ['Authoritative']), ['Authoritative']);
  assert.deepEqual(await stream.complete('other', 'turn', 'item', []), ['other thread']);
  assert.deepEqual(await stream.complete('thread', 'next', 'item', []), ['next turn']);
});

test('exit flushes pending public text without inventing item completion or accepting later deltas', async t => {
  const { stream, events } = fixture(t);
  await stream.append({ ...base, delta: 'Already' });
  await stream.append({ ...base, delta: ' recognized' });
  await stream.close();
  assert.deepEqual(summary(events.at(-1)!), ['Already recognized']);
  assert.ok(events.every(e => e.type === 'item.started'));
  await stream.append({ ...base, itemId: 'late', delta: 'late' });
  assert.equal(events.length, 2);
});

test('turn end saves outstanding summaries once and rejects late events from that turn', async t => {
  const { stream, events } = fixture(t);
  await stream.append({ ...base, delta: 'Public summary' });
  await stream.finishTurn('thread', 'turn');
  assert.equal(events.at(-1)!.type, 'item.completed');
  await stream.append({ ...base, itemId: 'late', delta: 'late' });
  await stream.finishTurn('thread', 'turn');
  assert.equal(events.length, 2);
});

test('invalid identities and indices are ignored; bytes and concurrent buffers are bounded', async t => {
  const { stream, events } = fixture(t);
  for (const params of [{ ...base, threadId: '' }, { ...base, summaryIndex: -1 }, { ...base, summaryIndex: 1.5 }, { ...base, summaryIndex: 32 }]) {
    await stream.append({ ...params, delta: 'invalid' });
  }
  assert.equal(events.length, 0);
  await stream.append({ ...base, delta: 'x'.repeat(100_000) });
  await stream.append({ ...base, delta: 'overflow' });
  assert.equal((await stream.complete('thread', 'turn', 'item', []))[0]!.length, 64_000);
  for (let i = 0; i < 70; i++) await stream.append({ ...base, itemId: String(i), delta: 'ok' });
  assert.equal(events.length, 65);
});

test('native notification integration accepts public summaries only and persists them on completion', async () => {
  const events: AppEvent[] = [];
  const server = new CodexAppServer({ findManagedThread: id => id === 'thread' ? { nativeThreadId: id } as ManagedThread : undefined,
    findProject: () => undefined, onApproval: async () => {}, onApprovalResolved: async () => {},
    onEvent: async e => { events.push(e); }, onVolatile: () => {}, onExit: async () => {},
  } as AppServerCallbacks);
  const handle = (server as unknown as { handleLine(line: string): Promise<void> }).handleLine.bind(server);
  const send = (method: string, params: unknown) => handle(JSON.stringify({ method, params }));
  await send('item/reasoning/textDelta', { ...base, delta: 'RAW MUST NOT APPEAR' });
  await send('item/reasoning/summaryTextDelta', { ...base, threadId: 'foreign', delta: 'foreign' });
  assert.equal(events.length, 0);
  await send('item/reasoning/summaryTextDelta', { ...base, delta: 'Public explanation' });
  await send('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'reasoning', summary: [], content: ['RAW MUST NOT APPEAR'] } });
  assert.deepEqual(summary(events.at(-1)!), ['Public explanation']);
  assert.equal(events.at(-1)!.type, 'item.completed');
  assert.ok(!JSON.stringify(events).includes('RAW MUST NOT APPEAR'));
  await server.stop();
});
