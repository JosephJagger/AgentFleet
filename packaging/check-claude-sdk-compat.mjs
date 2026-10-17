#!/usr/bin/env node
// Early warning for managed Claude updates: the official stable manifest lists the Agent SDK wrapper versions it
// was tested with. When the pinned SDK drops out of that rolling list, automatic updates stop (PROVIDER_SDK_UNREVIEWED).
// Run it periodically (cron/CI, non-blocking) and bump @anthropic-ai/claude-agent-sdk + CLAUDE_SDK_VERSION when it warns.
import { readFile } from 'node:fs/promises';
const BASE = 'https://downloads.claude.ai/claude-code-releases';
const WARN_WITHIN = Number(process.env.SDK_COMPAT_WARN_WITHIN ?? 8);
const root = new URL('..', import.meta.url);
const source = await readFile(new URL('apps/local-agent/src/provider-runtime-manager.ts', root), 'utf8');
const pinned = /CLAUDE_SDK_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(source)?.[1];
const dependency = JSON.parse(await readFile(new URL('apps/local-agent/package.json', root), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk'];
if (!pinned) { console.error('FAIL cannot read CLAUDE_SDK_VERSION'); process.exit(2); }
if (dependency !== pinned) { console.error(`FAIL package.json pins ${dependency} but CLAUDE_SDK_VERSION is ${pinned}`); process.exit(1); }
const get = async path => { const r = await fetch(`${BASE}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return (await r.text()).trim(); };
const stable = await get('stable');
if (!/^\d+\.\d+\.\d+$/.test(stable)) { console.error(`FAIL unexpected stable version ${stable}`); process.exit(2); }
const compat = JSON.parse(await get(`${stable}/manifest.json`)).sdkCompat;
const tested = [...(compat?.testedWrapperVersions ?? [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const position = tested.indexOf(pinned);
const newest = tested.at(-1);
let latestNpm = 'unknown';
try { latestNpm = (await (await fetch('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest', { signal: AbortSignal.timeout(20_000) })).json()).version ?? 'unknown'; } catch { /* informational only */ }
console.log(`stable Claude Code ${stable}; pinned SDK ${pinned}; newest tested wrapper ${newest}; npm latest ${latestNpm}`);
if (position < 0) { console.error(`FAIL pinned SDK ${pinned} is not covered by stable ${stable}: managed auto-update is blocked. Review and bump the SDK pin.`); process.exit(1); }
const fromOldest = position;
if (fromOldest < WARN_WITHIN) { console.warn(`WARN pinned SDK is ${fromOldest + 1} of ${tested.length} from the oldest tested entry; it will drop out of the list soon. Plan an SDK bump.`); process.exit(0); }
console.log(`OK pinned SDK is covered (${tested.length - position - 1} newer wrapper versions listed)`);
