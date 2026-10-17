import { expect, it } from 'vitest';
import { isNewerVersion, providerUpdateOffer } from './provider-updates';
import type { Machine } from './types';
const machine = (patch: Partial<Machine> = {}) => ({ id: 'm', reachability: 'live', codexVersion: '0.162.1', codexProfile: { source: 'managed' }, ...patch }) as Machine;
const now = '2026-10-17T00:00:00Z';
it('compares only stable x.y.z versions and ignores decoration', () => {
  expect(isNewerVersion('2.1.10', '2.1.9')).toBe(true);
  expect(isNewerVersion('2.1.9', '2.1.10')).toBe(false);
  expect(isNewerVersion('2.1.292', '2.1.292 (Claude Code)')).toBe(false);
  expect(isNewerVersion('0.163.0', 'codex-cli 0.162.1')).toBe(true);
  expect(isNewerVersion(undefined, '1.0.0')).toBe(false);
  expect(isNewerVersion('1.0.0', null)).toBe(false);
});
it('Codex offers a confirmation only for a validated, newer, managed target', () => {
  const profile = (patch: object) => machine({ codexProfile: { source: 'managed', runtimeUpdateState: 'awaiting_confirmation', runtimeUpdateTarget: '0.163.0', ...patch } as Machine['codexProfile'] });
  expect(providerUpdateOffer('codex', profile({}), undefined, '0.162.1')).toEqual({ kind: 'codex-confirm', latest: '0.163.0' });
  expect(providerUpdateOffer('codex', profile({ source: 'host' }), undefined, '0.162.1')).toBeUndefined();
  expect(providerUpdateOffer('codex', profile({ runtimeUpdateState: 'preparing' }), undefined, '0.162.1')).toBeUndefined();
  expect(providerUpdateOffer('codex', profile({ runtimeUpdateTarget: '0.162.1' }), undefined, '0.162.1')).toBeUndefined();
  expect(providerUpdateOffer('codex', { ...profile({}), reachability: 'unreachable' } as Machine, undefined, '0.162.1')).toBeUndefined();
});
it('Claude: managed builds can be updated on request, host installs and auto mode only inform or stay quiet', () => {
  const policy = (mode: 'host' | 'pinned' | 'auto', current?: string) => ({ revision: 1, mode, ...(current ? { current: { version: current, sha256: 'a'.repeat(64), size: 1, platform: 'linux-x64', checkedAt: now, sdkVersion: '0.3.285' } } : {}), latest: { claude: { version: '2.1.300', checkedAt: now } } });
  expect(providerUpdateOffer('claude', machine(), policy('pinned', '2.1.292'), '2.1.292')).toEqual({ kind: 'claude-update', latest: '2.1.300' });
  expect(providerUpdateOffer('claude', machine(), policy('host'), '2.1.296')).toEqual({ kind: 'notify', latest: '2.1.300' });
  expect(providerUpdateOffer('claude', machine(), policy('auto', '2.1.292'), '2.1.292')).toBeUndefined();
  expect(providerUpdateOffer('claude', machine(), policy('pinned', '2.1.300'), '2.1.300')).toBeUndefined();
  expect(providerUpdateOffer('claude', machine(), { revision: 1, mode: 'host', stableVersion: '2.1.300' }, '2.1.296')).toEqual({ kind: 'notify', latest: '2.1.300' });
});
it('other agents only get a notice, and a Kimi major jump is a migration, not an update', () => {
  const policy = { revision: 0, mode: 'host' as const, latest: { qwen: { version: '0.25.2', checkedAt: now }, kimi: { version: '2.2.0', checkedAt: now }, grok: { version: '1.0.62', checkedAt: now } } };
  expect(providerUpdateOffer('qwen', machine(), policy, '0.24.0')).toEqual({ kind: 'notify', latest: '0.25.2' });
  expect(providerUpdateOffer('qwen', machine(), policy, '0.25.2')).toBeUndefined();
  expect(providerUpdateOffer('kimi', machine(), policy, '1.52.0')).toBeUndefined();
  expect(providerUpdateOffer('kimi', machine(), { ...policy, latest: { kimi: { version: '2.3.0', checkedAt: now } } }, '2.2.0')).toEqual({ kind: 'notify', latest: '2.3.0' });
  expect(providerUpdateOffer('cursor', machine(), policy, '1.0.0')).toBeUndefined();
  expect(providerUpdateOffer('grok', machine(), policy, null)).toBeUndefined();
});
