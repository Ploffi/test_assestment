/**
 * Action execution semantics (ADR-014).
 *
 *  - Multiple actions reachable from a single event run in PARALLEL
 *    (their `.fn` invocations interleave; no sequential await).
 *  - Failures are ISOLATED: one action's throw does not cancel siblings.
 *  - `evaluate()` rejects only AFTER all parallel actions settle.
 *  - One throw → single `Error`. Many throws → `AggregateError` (or an
 *    error with an `errors[]` field for environments without AggregateError).
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  action,
} from '../_harness.js';

describe('parallel-isolated actions', () => {
  test('multiple actions start in parallel (overlapping work)', async () => {
    let aStart = 0;
    let bStart = 0;

    const a = action('a').args(z.object({})).fn(async () => {
      aStart = Date.now();
      await new Promise((r) => setTimeout(r, 30));
    });
    const b = action('b').args(z.object({})).fn(async () => {
      bStart = Date.now();
      await new Promise((r) => setTimeout(r, 30));
    });

    const r = rule('r').on('push').when(() => true).action('a').action('b');
    const engine = createEngine();
    engine.register({ actions: [a({}), b({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push'));
    // Both start within a small window — sequential would put one ≥30ms later.
    expect(Math.abs(aStart - bStart) < 10).toBe(true);
  });

  test('one failure does NOT short-circuit siblings', async () => {
    const aFn = vi.fn(async () => {});
    const bFn = vi.fn(async () => {
      throw new Error('B');
    });
    const cFn = vi.fn(async () => {});

    const a = action('a').args(z.object({})).fn(aFn);
    const b = action('b').args(z.object({})).fn(bFn);
    const c = action('c').args(z.object({})).fn(cFn);

    const r = rule('r')
      .on('push')
      .when(() => true)
      .action('a')
      .action('b')
      .action('c');

    const engine = createEngine();
    engine.register({ actions: [a({}), b({}), c({})], rules: [r()] });

    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toThrow();
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
    expect(cFn).toHaveBeenCalledTimes(1);
  });

  test('evaluate() rejects only AFTER every parallel action settles', async () => {
    let cFinishedAt = 0;

    const a = action('a').args(z.object({})).fn(async () => {});
    const b = action('b').args(z.object({})).fn(async () => {
      throw new Error('B');
    });
    const c = action('c').args(z.object({})).fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      cFinishedAt = Date.now();
    });

    const r = rule('r').on('push').when(() => true).action('a').action('b').action('c');
    const engine = createEngine();
    engine.register({ actions: [a({}), b({}), c({})], rules: [r()] });

    const startedAt = Date.now();
    let rejectedAt = 0;
    await engine
      .evaluate(fakeEnvelope('push'))
      .catch(() => {
        rejectedAt = Date.now();
      });

    expect(rejectedAt >= cFinishedAt).toBe(true);
    expect(rejectedAt - startedAt >= 25).toBe(true);
  });

  test('multiple parallel throws → AggregateError listing every failure', async () => {
    const a = action('a').args(z.object({})).fn(async () => {
      throw new Error('A');
    });
    const b = action('b').args(z.object({})).fn(async () => {
      throw new Error('B');
    });

    const r = rule('r').on('push').when(() => true).action('a').action('b');
    const engine = createEngine();
    engine.register({ actions: [a({}), b({})], rules: [r()] });

    let caught: unknown;
    try {
      await engine.evaluate(fakeEnvelope('push'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof AggregateError) {
      const msgs = caught.errors.map((x: Error) => x.message).sort();
      expect(msgs).toEqual(['A', 'B']);
    } else {
      // Implementations without AggregateError may use an Error with
      // an `errors[]` field; verify shape rather than concrete class.
      const errs = (caught as { errors?: Error[] }).errors;
      expect(Array.isArray(errs)).toBe(true);
      expect(errs?.length).toBe(2);
    }
  });

  test('actions on multiple matching rules share the parallel pool', async () => {
    const calls: string[] = [];
    const rec = (name: string) =>
      action(name).args(z.object({})).fn(async () => {
        calls.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`end ${name}`);
      });

    const a = rec('a');
    const b = rec('b');
    const c = rec('c');

    const r1 = rule('r1').on('push').when(() => true).action('a').action('b');
    const r2 = rule('r2').on('push').when(() => true).action('c');

    const engine = createEngine();
    engine.register({ actions: [a({}), b({}), c({})], rules: [r1(), r2()] });

    await engine.evaluate(fakeEnvelope('push'));
    // All three actions begin before any ends (parallel-isolated across rules).
    const starts = calls.filter((s) => s.startsWith('start ')).length;
    const firstEndIndex = calls.findIndex((s) => s.startsWith('end '));
    expect(starts).toBe(3);
    expect(firstEndIndex >= 3).toBe(true);
  });
});
