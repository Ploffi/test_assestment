/**
 * Unit tests for `createInMemoryAggregationStore` (ADR-006).
 *
 * Covers:
 *  - append + count + list per (ruleId, actionId, keyId)
 *  - rolling window: cutoff at `now - windowMs` (driven by injected clock)
 *  - appendAndCount returns the post-insert windowed count
 *  - prune drops entries older than the cutoff
 *  - independent buckets (ruleId / actionId / keyId all participate)
 *  - sorted ascending order in `list` regardless of insertion order
 */

import { describe, test, expect } from 'vitest';

import { createInMemoryAggregationStore } from '../../utility/aggregation-store.js';
import { createManualClock } from '../../utility/clock.js';
import type { AggregationEntry } from '../../public/index.js';

const entry = (at: number, deliveryId: string, payload: unknown = {}): AggregationEntry => ({
  at,
  deliveryId,
  payload,
});

describe('createInMemoryAggregationStore — append + count + list', () => {
  test('append → count reflects every entry inside the window', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });

    await store.append('r', 'a', 'k', entry(5_000, 'd1'));
    await store.append('r', 'a', 'k', entry(6_000, 'd2'));
    await store.append('r', 'a', 'k', entry(7_000, 'd3'));

    const count = await store.count('r', 'a', 'k', 5_000); // now=10_000, cutoff=5_000
    expect(count).toBe(3);
  });

  test('list returns entries in ascending `at` order', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });

    // Out-of-order inserts.
    await store.append('r', 'a', 'k', entry(7_000, 'd3'));
    await store.append('r', 'a', 'k', entry(5_000, 'd1'));
    await store.append('r', 'a', 'k', entry(6_000, 'd2'));

    const got = await store.list('r', 'a', 'k', 5_000);
    expect(got.map((e) => e.deliveryId)).toEqual(['d1', 'd2', 'd3']);
  });

  test('list returns a copy — mutation does not affect the store', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });
    await store.append('r', 'a', 'k', entry(5_000, 'd1'));

    const got = await store.list('r', 'a', 'k', 5_000);
    got.length = 0;

    const again = await store.list('r', 'a', 'k', 5_000);
    expect(again.length).toBe(1);
  });
});

describe('createInMemoryAggregationStore — rolling window', () => {
  test('entries older than `now - windowMs` are excluded from count', async () => {
    const clock = createManualClock(0);
    const store = createInMemoryAggregationStore({ clock });

    await store.append('r', 'a', 'k', entry(0, 'd1'));
    clock.advance(10 * 60_000);
    await store.append('r', 'a', 'k', entry(clock.now(), 'd2'));
    clock.advance(60 * 60_000); // total = 70 min

    // Window = 1h; cutoff = 70m − 60m = 10m. Entry d1 (at=0) is excluded.
    const count = await store.count('r', 'a', 'k', 60 * 60_000);
    expect(count).toBe(1);
  });

  test('count is the entire bucket when window encompasses all entries', async () => {
    const clock = createManualClock(0);
    const store = createInMemoryAggregationStore({ clock });
    await store.append('r', 'a', 'k', entry(0, 'd1'));
    await store.append('r', 'a', 'k', entry(100, 'd2'));
    clock.set(1_000);
    const count = await store.count('r', 'a', 'k', 10_000);
    expect(count).toBe(2);
  });

  test('count is 0 when window precedes every entry', async () => {
    const clock = createManualClock(100_000);
    const store = createInMemoryAggregationStore({ clock });
    await store.append('r', 'a', 'k', entry(0, 'd1'));
    await store.append('r', 'a', 'k', entry(50, 'd2'));
    const count = await store.count('r', 'a', 'k', 1_000);
    expect(count).toBe(0);
  });

  test('boundary: entry at exactly cutoff is included (closed lower bound)', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });
    await store.append('r', 'a', 'k', entry(5_000, 'on-boundary'));
    // cutoff = 10_000 − 5_000 = 5_000. Spec: [now − windowMs, now] is closed.
    const count = await store.count('r', 'a', 'k', 5_000);
    expect(count).toBe(1);
  });

  test('entries after `now` are excluded from count and list (closed upper bound)', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });

    await store.append('r', 'a', 'k', entry(9_000, 'inside'));
    await store.append('r', 'a', 'k', entry(10_000, 'on-now'));
    await store.append('r', 'a', 'k', entry(11_000, 'future'));

    expect(await store.count('r', 'a', 'k', 5_000)).toBe(2);
    expect((await store.list('r', 'a', 'k', 5_000)).map((e) => e.deliveryId)).toEqual([
      'inside',
      'on-now',
    ]);
  });
});

describe('createInMemoryAggregationStore — appendAndCount', () => {
  test('returns the post-insert windowed count atomically', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });
    // The default in-memory store always provides the optional method.
    const fn = store.appendAndCount;
    expect(fn).toBeTruthy();
    if (!fn) return;

    const c1 = await fn('r', 'a', 'k', entry(9_000, 'd1'), 5_000);
    expect(c1).toBe(1);

    const c2 = await fn('r', 'a', 'k', entry(9_500, 'd2'), 5_000);
    expect(c2).toBe(2);
  });
});

describe('createInMemoryAggregationStore — buckets are independent', () => {
  test('different ruleId/actionId/keyId do not share entries', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });

    await store.append('r1', 'a', 'k', entry(9_000, 'r1-d1'));
    await store.append('r2', 'a', 'k', entry(9_000, 'r2-d1'));
    await store.append('r1', 'a2', 'k', entry(9_000, 'a2-d1'));
    await store.append('r1', 'a', 'k2', entry(9_000, 'k2-d1'));

    expect(await store.count('r1', 'a', 'k', 5_000)).toBe(1);
    expect(await store.count('r2', 'a', 'k', 5_000)).toBe(1);
    expect(await store.count('r1', 'a2', 'k', 5_000)).toBe(1);
    expect(await store.count('r1', 'a', 'k2', 5_000)).toBe(1);
  });

  test('count on an empty bucket returns 0', async () => {
    const store = createInMemoryAggregationStore();
    expect(await store.count('r', 'a', 'k', 1_000)).toBe(0);
  });
});

describe('createInMemoryAggregationStore — prune', () => {
  test('drops entries older than `now - olderThanMs`', async () => {
    const clock = createManualClock(0);
    const store = createInMemoryAggregationStore({ clock });

    await store.append('r', 'a', 'k', entry(0, 'd1'));
    await store.append('r', 'a', 'k', entry(1_000, 'd2'));
    await store.append('r', 'a', 'k', entry(2_000, 'd3'));

    clock.set(2_500);
    await store.prune?.(1_000); // cutoff = 2_500 − 1_000 = 1_500

    const remaining = await store.list('r', 'a', 'k', 10_000);
    expect(remaining.map((e) => e.deliveryId)).toEqual(['d3']);
  });

  test('prune across multiple buckets sweeps each', async () => {
    const clock = createManualClock(10_000);
    const store = createInMemoryAggregationStore({ clock });
    await store.append('r', 'a', 'k1', entry(0, 'old'));
    await store.append('r', 'a', 'k1', entry(9_000, 'new'));
    await store.append('r', 'a', 'k2', entry(0, 'old'));
    await store.append('r', 'a', 'k2', entry(9_500, 'new'));

    await store.prune?.(5_000); // cutoff = 5_000

    expect(await store.count('r', 'a', 'k1', 10_000)).toBe(1);
    expect(await store.count('r', 'a', 'k2', 10_000)).toBe(1);
  });
});

describe('createInMemoryAggregationStore — default clock', () => {
  test('without an explicit clock, falls back to SystemClock', async () => {
    const store = createInMemoryAggregationStore();
    const now = Date.now();
    await store.append('r', 'a', 'k', entry(now - 1_000, 'd1'));
    const count = await store.count('r', 'a', 'k', 5_000);
    expect(count).toBe(1);
  });
});
