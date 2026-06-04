/**
 * Clock injection contract (ADR-015).
 *
 *  - `Clock` is optional in EngineOptions; default is `SystemClock`.
 *  - When a `ManualClock` is injected, `ctx.now` reads from it and timers
 *    scheduled via `clock.setTimeout` only fire on `advance(...)`.
 *  - The engine code path never reaches for the global `Date.now` /
 *    `setTimeout` — that is enforced by a lint rule in the engine package
 *    and indirectly here by the determinism of these tests.
 */

import { describe, test, expect } from 'vitest';

import {
  createEngine,
  createManualClock,
  fakeEnvelope,
  rule,
  predicate,
  action,
  use,
} from '../_harness.js';
import { z } from 'zod';

describe('clock — injection + reads', () => {
  test('ctx.now equals clock.now() at evaluation start (frozen)', async () => {
    const clock = createManualClock(1_700_000_000_000);

    let observedAtPredicate: number | undefined;
    let observedAtAction: number | undefined;

    const probePred = predicate('probe-pred')
      .args(z.object({}))
      .fn(async (ctx) => {
        observedAtPredicate = ctx.now;
        return true;
      });
    const probeAct = action('probe-act')
      .args(z.object({}))
      .fn(async (ctx) => {
        observedAtAction = ctx.now;
      });
    const r = rule('probe-rule').on('push').when(use('probe-pred')).action('probe-act');

    const engine = createEngine({ clock });
    engine.register({
      predicates: [probePred({})],
      actions: [probeAct({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(observedAtPredicate).toBe(1_700_000_000_000);
    // The contract is "frozen at evaluation start" — predicate and action see the same value.
    expect(observedAtAction).toBe(observedAtPredicate);
  });

  test('advance() fires due timers; absent advance, they do not fire', async () => {
    const clock = createManualClock(0);

    let fired = false;
    const timer = clock.setTimeout(() => {
      fired = true;
    }, 5_000);
    void timer;

    // No advance: nothing fires.
    await Promise.resolve();
    expect(fired).toBe(false);

    clock.advance(4_999);
    await Promise.resolve();
    expect(fired).toBe(false);

    clock.advance(1);
    // After the deadline lies in the past, the callback runs in this advance pass.
    expect(fired).toBe(true);
  });

  test('Timer.cancel() prevents a scheduled callback from firing', () => {
    const clock = createManualClock(0);
    let fired = false;
    const t = clock.setTimeout(() => {
      fired = true;
    }, 100);
    t.cancel();
    clock.advance(1_000);
    expect(fired).toBe(false);
  });

  test('set(timeMs) jumps the clock forward; due timers fire on the next advance', () => {
    const clock = createManualClock(0);
    let count = 0;
    clock.setTimeout(() => count++, 50);
    clock.setTimeout(() => count++, 200);
    clock.set(150);
    clock.advance(0); // sweep
    expect(count).toBe(1);
    clock.advance(100);
    expect(count).toBe(2);
  });
});
