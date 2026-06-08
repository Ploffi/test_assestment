import type { Duration } from '../../public/rule.js';

export function parseDuration(d: Duration): number {
  if (typeof d === 'number') return d;
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(d.trim());
  if (!m) throw new Error(`invalid duration: ${d}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 's': return n * 1_000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
  }
  throw new Error('unreachable');
}
