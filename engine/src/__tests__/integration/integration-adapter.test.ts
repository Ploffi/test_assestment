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
  createManualClock,
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

  test('TTL cache expires according to the engine clock and excludes signal from the key', async () => {
    const clock = createManualClock(0);
    const underlying = vi.fn(async () => ({ ok: true }));
    const probe = integration('probe')
      .cache({ ttl: 10, max: 100 })
      .methods({
        get: async (i: { key: string; signal?: AbortSignal }) => {
          void i;
          return underlying();
        },
      });
    const p = predicate('p')
      .args(z.object({}))
      .fn(async (ctx) => Boolean(await ctx.integrations['probe']?.['get']({ key: 'x', signal: ctx.signal })));
    const a = action('a').args(z.object({})).fn(async () => {});
    const r = rule('r').on('push').when(use('p')).action('a');
    const engine = createEngine({ clock });
    engine.register({ integrations: [probe], predicates: [p({})], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', undefined, 'd1'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'd2'));
    expect(underlying).toHaveBeenCalledTimes(1);

    clock.advance(10);
    await engine.evaluate(fakeEnvelope('push', undefined, 'd3'));
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  test('retry re-invokes a failing underlying call before surfacing failure', async () => {
    const underlying = vi
      .fn<() => Promise<{ ok: true }>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });
    const probe = integration('probe')
      .retry({ attempts: 2, backoffMs: 0 })
      .methods({
        get: async (_i: { signal?: AbortSignal }) => underlying(),
      });
    const fired = vi.fn(async () => {});
    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        await ctx.integrations['probe']?.['get']({ signal: ctx.signal });
        await fired();
      });
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();
    engine.register({ integrations: [probe], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push'));
    expect(underlying).toHaveBeenCalledTimes(2);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  test('breaker opens after failure, fails fast, and half-open probes after reset', async () => {
    const clock = createManualClock(0);
    let calls = 0;
    const probe = integration('probe')
      .breaker({ errorThresholdPct: 50, resetMs: 100 })
      .methods({
        get: async (_i: { signal?: AbortSignal }) => {
          calls++;
          if (calls === 1) throw new Error('down');
          return { ok: true };
        },
      });
    const p = predicate('p')
      .args(z.object({}))
      .fn(async (ctx) => Boolean(await ctx.integrations['probe']?.['get']({ signal: ctx.signal })));
    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);
    const r = rule('r').on('push').when(use('p')).action('a');
    const engine = createEngine({ clock });
    engine.register({ integrations: [probe], predicates: [p({})], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', undefined, 'd1'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'd2'));
    expect(calls).toBe(1);
    expect(fired).not.toHaveBeenCalled();

    clock.advance(100);
    await engine.evaluate(fakeEnvelope('push', undefined, 'd3'));
    expect(calls).toBe(2);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  test('concurrency limit is shared across action call sites for one integration', async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const probe = integration('probe')
      .concurrency(1)
      .methods({
        go: async (i: { name: string; signal?: AbortSignal }) => {
          started.push(i.name);
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      });
    const makeAction = (name: string) =>
      action(name)
        .args(z.object({}))
        .fn(async (ctx) => {
          await ctx.integrations['probe']?.['go']({ name, signal: ctx.signal });
        });
    const a = makeAction('a');
    const b = makeAction('b');
    const r = rule('r').on('push').when(() => true).action('a').action('b');
    const engine = createEngine();
    engine.register({ integrations: [probe], actions: [a({}), b({})], rules: [r()] });

    const evaluation = engine.evaluate(fakeEnvelope('push'));
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a']);

    releases.shift()?.();
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(['a', 'b']);

    releases.shift()?.();
    await evaluation;
  });

  test('external.call emits runtime metrics with delivery id and cache hit state', async () => {
    const events: Array<{ deliveryId: string; cacheHit: boolean; ok: boolean }> = [];
    const probe = integration('probe')
      .cache({ ttl: '1h' })
      .methods({ get: async (_i: { signal?: AbortSignal }) => ({ ok: true }) });
    const p = predicate('p')
      .args(z.object({}))
      .fn(async (ctx) => Boolean(await ctx.integrations['probe']?.['get']({ signal: ctx.signal })));
    const a = action('a').args(z.object({})).fn(async () => {});
    const r = rule('r').on('push').when(use('p')).action('a');
    const engine = createEngine();
    engine.on('external.call', (event) => events.push(event));
    engine.register({ integrations: [probe], predicates: [p({})], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-a'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-b'));

    expect(events.map((e) => ({ deliveryId: e.deliveryId, cacheHit: e.cacheHit, ok: e.ok }))).toEqual([
      { deliveryId: 'delivery-a', cacheHit: false, ok: true },
      { deliveryId: 'delivery-b', cacheHit: true, ok: true },
    ]);
  });

  test('cache handles null inputs and evicts least-recently-used entries at max size', async () => {
    const events: Array<{ deliveryId: string; cacheHit: boolean }> = [];
    const underlying = vi.fn(async (_i: null | { key: string; signal?: AbortSignal }) => ({ ok: true }));
    const probe = integration('probe')
      .cache({ ttl: '1d', max: 1 })
      .methods({ get: underlying });
    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        const ref = (ctx.event as any).ref as string;
        const input = ref === 'none' ? null : { key: ref, signal: ctx.signal };
        await ctx.integrations['probe']?.['get'](input);
      });
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();
    engine.on('external.call', (event) => events.push({ deliveryId: event.deliveryId, cacheHit: event.cacheHit }));
    engine.register({ integrations: [probe], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', { ref: 'none' } as any, 'delivery-null-1'));
    await engine.evaluate(fakeEnvelope('push', { ref: 'other' } as any, 'delivery-other'));
    await engine.evaluate(fakeEnvelope('push', { ref: 'none' } as any, 'delivery-null-2'));

    expect(underlying).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      { deliveryId: 'unknown', cacheHit: false },
      { deliveryId: 'delivery-other', cacheHit: false },
      { deliveryId: 'unknown', cacheHit: false },
    ]);
  });

  test('retry backoff waits on the injected clock before re-attempting', async () => {
    const clock = createManualClock(0);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const underlying = vi
      .fn<() => Promise<{ ok: true }>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ ok: true });
    const probe = integration('probe')
      .retry({ attempts: 2, backoffMs: 100, jitter: true })
      .methods({ get: async (_i: { signal?: AbortSignal }) => underlying() });
    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        await ctx.integrations['probe']?.['get']({ signal: ctx.signal });
      });
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine({ clock });
    engine.register({ integrations: [probe], actions: [a({})], rules: [r()] });

    const evaluation = engine.evaluate(fakeEnvelope('push'));
    await new Promise((r) => setImmediate(r));
    expect(underlying).toHaveBeenCalledTimes(1);

    clock.advance(100);
    await evaluation;
    expect(underlying).toHaveBeenCalledTimes(2);
    random.mockRestore();
  });

  test('retry backoff rejects immediately when the adapter input signal is already aborted', async () => {
    const underlying = vi.fn(async () => {
      throw new Error('transient');
    });
    const probe = integration('probe')
      .retry({ attempts: 2, backoffMs: 100 })
      .methods({ get: async (_i: { signal?: AbortSignal }) => underlying() });
    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        const ac = new AbortController();
        ac.abort();
        await ctx.integrations['probe']?.['get']({ signal: ac.signal });
      });
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();
    engine.register({ integrations: [probe], actions: [a({})], rules: [r()] });

    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toThrow(/aborted/);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  test('half-open breaker failure reopens the breaker and fails fast again', async () => {
    const clock = createManualClock(0);
    let calls = 0;
    const probe = integration('probe')
      .breaker({ errorThresholdPct: 50, resetMs: 100 })
      .methods({
        get: async (_i: { signal?: AbortSignal }) => {
          calls++;
          throw new Error('still down');
        },
      });
    const p = predicate('p')
      .args(z.object({}))
      .fn(async (ctx) => Boolean(await ctx.integrations['probe']?.['get']({ signal: ctx.signal })));
    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);
    const r = rule('r').on('push').when(use('p')).action('a');
    const engine = createEngine({ clock });
    engine.register({ integrations: [probe], predicates: [p({})], actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', undefined, 'd1'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'd2'));
    expect(calls).toBe(1);

    clock.advance(100);
    await engine.evaluate(fakeEnvelope('push', undefined, 'd3'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'd4'));

    expect(calls).toBe(2);
    expect(fired).not.toHaveBeenCalled();
  });
});
