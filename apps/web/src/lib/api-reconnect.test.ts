// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { subscribeToFleet } from './api';
import type { FleetSession } from './types';

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  close = vi.fn(() => { this.readyState = 3; }); // Deliberately no close event: a dead network can delay it.
  send(value: string) { this.sent.push(JSON.parse(value)); }
  constructor(public url: string) { super(); Socket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start() {
  const onChange = vi.fn(), onConnection = vi.fn(), onVolatile = vi.fn();
  let sequence = 3;
  stop = subscribeToFleet(() => [{id:'session-a',sessionSeq:sequence,projectionEpoch:1} as FleetSession], onChange, onConnection, onVolatile);
  return { onChange, onConnection, onVolatile, advanceSequence: () => { sequence = 9; } };
}
it('retires a silent OPEN connection and resumes from the current event cursor without sending commands', () => {
  const state = start(); const old = Socket.instances[0]; old.open();
  expect(old.sent.map(x => x.type)).toEqual(['subscribe','ping']);
  state.advanceSequence();
  vi.advanceTimersByTime(10_001);
  expect(old.close).toHaveBeenCalledOnce();
  expect(Socket.instances).toHaveLength(2);
  const current = Socket.instances[1]; current.open(); current.message({type:'pong'});
  expect(current.sent[0]).toMatchObject({type:'subscribe',lastAppliedSeq:9});
  expect(state.onChange).toHaveBeenCalledTimes(2);
  expect(state.onConnection.mock.calls.map(([value])=>value)).toEqual([true,false,true]);
  expect([...old.sent,...current.sent].every(x=>['subscribe','ping'].includes(String(x.type)))).toBe(true);
});
it('answered heartbeats keep a healthy connection open', () => {
  start(); const socket = Socket.instances[0]; socket.open(); socket.message({type:'pong'});
  for(let i=0;i<4;i++){ vi.advanceTimersByTime(25_000); socket.message({type:'pong'}); }
  expect(Socket.instances).toHaveLength(1); expect(socket.close).not.toHaveBeenCalled();
});
it('a stalled handshake is bounded and retried', () => {
  start(); const socket = Socket.instances[0];
  vi.advanceTimersByTime(10_500);
  expect(socket.close).toHaveBeenCalledOnce(); expect(Socket.instances).toHaveLength(2);
});
it('pauses while offline and reconnects immediately when the network returns', () => {
  const state = start(); Socket.instances[0].open();
  window.dispatchEvent(new Event('offline'));
  vi.advanceTimersByTime(120_000); expect(Socket.instances).toHaveLength(1);
  window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(1);
  expect(Socket.instances).toHaveLength(2); expect(state.onConnection).toHaveBeenLastCalledWith(false);
});
it('probes on foreground/focus without indefinitely extending an outstanding heartbeat', () => {
  start(); const socket = Socket.instances[0]; socket.open(); socket.message({type:'pong'});
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(5_000); document.dispatchEvent(new Event('visibilitychange'));
  expect(socket.sent.filter(x=>x.type==='ping')).toHaveLength(2);
  vi.advanceTimersByTime(5_001); expect(Socket.instances).toHaveLength(2);
});
it('late old-socket events cannot affect its replacement or replay stale output', () => {
  const state = start(); const old = Socket.instances[0]; old.open();
  vi.advanceTimersByTime(10_001); const current = Socket.instances[1]; current.open();current.message({type:'pong'});
  old.dispatchEvent(new Event('close')); old.dispatchEvent(new Event('error')); old.dispatchEvent(new Event('open'));
  old.message({type:'event'});
  old.message({type:'volatile',eventType:'agent_message.delta',logicalSessionId:'session-a',nativeTurnId:'turn',payload:{delta:'stale'}});
  expect(state.onChange).toHaveBeenCalledTimes(2); expect(state.onVolatile).not.toHaveBeenCalled();
  expect(current.close).not.toHaveBeenCalled(); expect(state.onConnection).toHaveBeenLastCalledWith(true);
});
it('unsubscribe removes all retry timers and browser event listeners', () => {
  const state = start(); Socket.instances[0].open();stop!();stop=undefined;
  state.onConnection.mockClear();
  for(const name of ['online','offline','focus'])window.dispatchEvent(new Event(name));
  document.dispatchEvent(new Event('visibilitychange'));vi.advanceTimersByTime(120_000);
  expect(Socket.instances).toHaveLength(1);expect(state.onConnection).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
