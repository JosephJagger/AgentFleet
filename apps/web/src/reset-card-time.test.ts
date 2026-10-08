import {expect,it} from 'vitest';
import {resetCardDetail} from './lib/reset-card-time';
it('shows both source UTC and Beijing time across dates and years without changing the ID',()=>{
 for (const [utc,beijing] of [
  ['2026-10-29 18:52:01','2026-10-30 02:52:01'],
  ['2026-11-06 23:19:41','2026-11-07 07:19:41'],
  ['2026-12-31 16:00:00','2027-01-01 00:00:00'],
 ]) {
  expect(resetCardDetail(`失效日期：${utc} UTC\n卡片 ID：fixture`,'北京时间（UTC+8）')).toBe(`失效日期：${utc} UTC\n北京时间（UTC+8）：${beijing}\n卡片 ID：fixture`);
 }
});
it('never invents expiry for missing, explicitly non-expiring, malformed or unrelated data',()=>{
 for(const detail of ['失效日期：未返回有效期','失效日期：不过期（原生注明）','失效日期：2026-02-30 00:00:00 UTC','卡片 ID：2026-10-29 18:52:01 UTC','2'])expect(resetCardDetail(detail,'北京时间')).toBe(detail);
});
