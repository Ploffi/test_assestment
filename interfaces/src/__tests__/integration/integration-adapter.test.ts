/**
 * Integration adapter wiring (ADR-005).
 *
 *  - Registered integrations are exposed on `ctx.integrations.<name>`.
 *  - Predicate / action `.fn` reach the adapter through that ctx field.
 *  - Resilience layers (cache → semaphore → breaker → retry → call) are
 *    properties of the integration, not of each call site — multiple
 *    callers of the same method share one cache / breaker / budget.
 *  - `ctx.signal` flows through into adapter calls (the adapter forwards
 *    it to the underlying fetch / sdk call).
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  predicate,
  action,
  integration,
  use,
} from '../_harness.js';

describe('integration adapter — exposure on ctx', () => {
  test('ctx.integrations.<name> exists for every registered integration', async () => {
    let seenA = false;
    let seenB = false;

    const intA = integration('int-a')
      .methods({
        ping: async (_i: { signal?: AbortSignal }) => 'a',
      });
    const intB = integration('int-b').methods({
      ping: async (_i: { signal?: AbortSignal }) => 'b',
    });

    const p = predicate('probe')
      .args(z.object({}))
      .fn(async (ctx) => {
        seenA = typeof ctx.integrations['int-a']?.['ping'] === 'function';
        seenB = typeof ctx.integrations['int-b']?.['ping'] === 'function';
        return true;
      });

    const r = rule('r').on('push').when(use('probe')).action('notify-slack');
    const notify = action('notify-slack')
      .args(z.object({}))
      .fn(async () => {});

    const engine = createEngine();
    engine.register({
      integrations: [intA, intB],
      predicates: [p()],
      actions: [notify({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(seenA).toBe(true);
    expect(seenB).toBe(true);
  });
});

describe('integration adapter — signal propagation', () => {
  test('ctx.signal threads into the adapter call input', async () => {
    let observed: AbortSignal | undefined;

    const probe = integration('probe').methods({
      go: async (i: { x: number; signal?: AbortSignal }) => {
        observed = i.signal;
        return i.x;
      },
    });

    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        await ctx.integrations['probe']?.['go']({ x: 1, signal: ctx.signal });
      });

    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();
    engine.register({
      integrations: [probe],
      actions: [a({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(observed).toBeInstanceOf(AbortSignal);
  });
});

describe('integration adapter — shared resilience layers', () => {
  test('two predicates calling the same method share one cache (one underlying call)', async () => {
    const underlying = vi.fn(async () => ({ label: 'ok', confidence: 0.9 }));

    const classifier = integration('classifier')
      .cache({ ttl: '1h', max: 100 })
      .breaker({ errorThresholdPct: 50, resetMs: 1_000 })
      .concurrency(5)
      .retry({ attempts: 1, backoffMs: 10 })
      .methods({
        classify: async (i: { text: string; signal?: AbortSignal }) => {
          void i;
          return underlying();
        },
      });

    const callIt = predicate('call-it')
      .args(z.object({ which: z.string() }))
      .fn(async (ctx) => {
        const r = await ctx.integrations['classifier']?.['classify']({
          text: 'same text',
          signal: ctx.signal,
        });
        return Boolean(r);
      });

    const r1 = rule('r1').on('push').when(use('call-it', { which: 'a' })).action('a');
    const r2 = rule('r2').on('push').when(use('call-it', { which: 'b' })).action('a');
    const a = action('a').args(z.object({})).fn(async () => {});

    const engine = createEngine();
    engine.register({
      integrations: [classifier],
      predicates: [callIt()],
      actions: [a({})],
      rules: [r1(), r2()],
    });

    // First event: cache miss → 1 underlying call.
    await engine.evaluate(fakeEnvelope('push'));
    expect(underlying).toHaveBeenCalledTimes(1);

    // Second event: cache hit (TTL not expired) → still 1.
    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-2'));
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  test('open breaker fails fast — predicate throws are isolated to `false` (ADR-005 cross-ref)', async () => {
    // Adapter behavior is supplied by the engine; here we contract that the
    // predicate's leaf-on-throw isolation is preserved when the call fails
    // (whether due to the breaker or the underlying call).
    const failing = integration('failing').methods({
      go: async (_i: { signal?: AbortSignal }) => {
        throw new Error('network');
      },
    });

    const p = predicate('p')
      .args(z.object({}))
      .fn(async (ctx) => {
        await ctx.integrations['failing']?.['go']({ signal: ctx.signal });
        return true;
      });

    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);

    const r = rule('r').on('push').when(use('p')).action('a');
    const engine = createEngine();
    engine.register({
      integrations: [failing],
      predicates: [p()],
      actions: [a({})],
      rules: [r()],
    });

    // evaluate resolves void; the predicate's throw isolates to a false leaf.
    await engine.evaluate(fakeEnvelope('push'));
    expect(fired).not.toHaveBeenCalled();
  });
});
