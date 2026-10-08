/** Add an explicit Beijing rendering to existing Agent reset-card receipts. */
export function resetCardDetail(detail: string, beijingLabel: string): string {
  const lines = detail.split('\n');
  const match = /^失效日期[：:]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC$/.exec(lines[0] ?? '');
  if (!match) return detail;
  const iso = match[1]!.replace(' ', 'T') + '.000Z';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) return detail;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const local = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
  return [lines[0], `${beijingLabel}：${local}`, ...lines.slice(1)].join('\n');
}
