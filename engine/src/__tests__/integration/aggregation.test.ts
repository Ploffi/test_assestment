/**
 * Aggregation lifecycle (ADR-006).
 *
 *  - Each matching event → `AggregationStore.append` per attached
 *    `aggregatedAction` with the action's `.transform(ctx)` payload.
 *  - Action fires only when the bucket count reaches `.aggregate.count`.
 *  - `keyId` is the rule's `.aggregate.key(ctx)` result.
 *  - Plain actions on aggregating rules also fire only on threshold hit
 *    (no `ctx.aggregate` populated).
 *  - `appendAndCount` is preferred when the store implements it.
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  createInMemoryAggregationStore,
  fakeEnvelope,
  rule,
  aggregatedAction,
  action,
} from '../_harness.js';
import type { AggregationStore, AggregationEntry } from '../../public/index.js';

/**
 * Build a tracking store that records every call. Used to assert the
 * engine drives the store through the documented sequence.
 */
function trackingStore(): AggregationStore & {
  calls: {
    appended: Array<[ruleId: string, actionId: string, keyId: string, entry: AggregationEntry]>;
    counted: Array<[ruleId: string, actionId: string, keyId: string]>;
  };
} {
  const inner = createInMemoryAggregationStore();
  const calls = {
    appended: [] as Array<
      [ruleId: string, actionId: string, keyId: string, entry: AggregationEntry]
    >,
    counted: [] as Array<[ruleId: string, actionId: string, keyId: string]>,
  };
  return {
    calls,
    async append(ruleId, actionId, keyId, entry) {
      calls.appended.push([ruleId, actionId, keyId, entry]);
      return inner.append(ruleId, actionId, keyId, entry);
    },
    async list(ruleId, actionId, keyId, windowMs) {
      return inner.list(ruleId, actionId, keyId, windowMs);
    },
    async count(ruleId, actionId, keyId, windowMs) {
      calls.counted.push([ruleId, actionId, keyId]);
      return inner.count(ruleId, actionId, keyId, windowMs);
    },
  };
}

describe('aggregation — below threshold', () => {
  test('first events below threshold append but do NOT fire actions', async () => {
    const store = trackingStore();
    const fn = vi.fn(async () => {});

    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform((ctx) => ({ id: ctx.event.workflow_run.id }))
      .fn(fn);

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({
        window: '1h',
        count: 3,
        key: (ctx) => String(ctx.event.workflow_run.pull_requests[0]?.id ?? 'k'),
      })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    await engine.evaluate(fakeEnvelope('workflow_run.completed'));

    expect(store.calls.appended.length).toBe(2);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('aggregation — threshold reached', () => {
  test('on the Nth event, aggregated action fires with ctx.aggregate.entries.length === N', async () => {
    const store = createInMemoryAggregationStore();

    let observedEntries = -1;
    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform((ctx) => ({ id: ctx.event.workflow_run.id }))
      .fn(async (ctx) => {
        observedEntries = ctx.aggregate.entries.length;
      });

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 3, key: () => 'pr-1' })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    await engine.evaluate(fakeEnvelope('workflow_run.completed'));

    expect(observedEntries).toBe(3);
  });

  test('keyId in the store key is the rule .aggregate.key(ctx) result', async () => {
    const store = trackingStore();
    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(async () => {});

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 3, key: () => 'pr-42' })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    expect(store.calls.appended[0]?.[2]).toBe('pr-42');
  });

  test('custom .aggregate.at(ctx) controls the stored entry timestamp', async () => {
    const store = trackingStore();
    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(async () => {});

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 3, key: () => 'pr-42', at: () => 123_456 })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));

    expect(store.calls.appended[0]?.[3].at).toBe(123_456);
  });

  test('two distinct keys live in separate buckets (different threshold timelines)', async () => {
    const store = createInMemoryAggregationStore();
    const fireCounts = { 'pr-A': 0, 'pr-B': 0 };

    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(async (ctx) => {
        fireCounts[ctx.aggregate.keyId as keyof typeof fireCounts] += 1;
      });

    let nextKey = 'pr-A';
    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 2, key: () => nextKey })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    nextKey = 'pr-A';
    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    nextKey = 'pr-B';
    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    nextKey = 'pr-A';
    await engine.evaluate(fakeEnvelope('workflow_run.completed')); // pr-A reaches 2

    expect(fireCounts['pr-A']).toBe(1);
    expect(fireCounts['pr-B']).toBe(0);
  });
});

describe('aggregation — multiple aggregated actions per rule', () => {
  test('each attached aggregatedAction writes its own bucket with its own .transform', async () => {
    const store = trackingStore();

    const aggA = aggregatedAction('agg-A')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform((ctx) => ({ kind: 'A' as const, id: ctx.event.workflow_run.id }))
      .fn(async () => {});
    const aggB = aggregatedAction('agg-B')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({ kind: 'B' as const, marker: 'b-only' }))
      .fn(async () => {});

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 5, key: () => 'k' })
      .action('agg-A')
      .action('agg-B');

    const engine = createEngine({ aggregationStore: store });
    engine.register({
      aggregatedActions: [aggA({}), aggB({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    // One append per attached aggregatedAction.
    expect(store.calls.appended.length).toBe(2);
    const actionIds = store.calls.appended.map(([, actionId]) => actionId).sort();
    expect(actionIds).toEqual(['agg-A', 'agg-B']);
    // Each payload reflects that action's own transform output.
    const payloads = store.calls.appended.map(([, , , entry]) => entry.payload);
    expect(payloads.some((p) => p.kind === 'A')).toBe(true);
    expect(payloads.some((p) => p.kind === 'B')).toBe(true);
  });
});

describe('aggregation — plain action on an aggregating rule', () => {
  test('plain action fires on threshold hit; ctx.aggregate is absent', async () => {
    const store = createInMemoryAggregationStore();
    const aggFire = vi.fn(async () => {});
    const plainFire = vi.fn(async () => {});

    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(aggFire);
    const plain = action('plain').args(z.object({})).fn(plainFire);

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 2, key: () => 'k' })
      .action('agg')
      .action('plain');

    const engine = createEngine({ aggregationStore: store });
    engine.register({
      aggregatedActions: [agg({})],
      actions: [plain({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('workflow_run.completed')); // 1
    expect(plainFire).not.toHaveBeenCalled();
    await engine.evaluate(fakeEnvelope('workflow_run.completed')); // 2 → threshold
    expect(aggFire).toHaveBeenCalledTimes(1);
    expect(plainFire).toHaveBeenCalledTimes(1);
  });
});

describe('aggregation — store optional fast path', () => {
  test('engine prefers appendAndCount when the store exposes it', async () => {
    const inner = createInMemoryAggregationStore();
    const fast = vi.fn(async (_r: string, _a: string, _k: string, e: AggregationEntry, _w: number) => {
      await inner.append(_r, _a, _k, e);
      return inner.count(_r, _a, _k, _w);
    });

    const store: AggregationStore = {
      append: inner.append.bind(inner),
      list: inner.list.bind(inner),
      count: inner.count.bind(inner),
      appendAndCount: fast,
    };

    const agg = aggregatedAction('agg')
      .on('workflow_run.completed')
      .args(z.object({}))
      .transform(() => ({}))
      .fn(async () => {});

    const r = rule('r')
      .on('workflow_run.completed')
      .when(() => true)
      .aggregate({ window: '1h', count: 3, key: () => 'k' })
      .action('agg');

    const engine = createEngine({ aggregationStore: store });
    engine.register({ aggregatedActions: [agg({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('workflow_run.completed'));
    expect(fast).toHaveBeenCalledTimes(1);
  });
});
