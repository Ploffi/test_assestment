/**
 * Unit tests for `SystemClock` + `ManualClock` (ADR-015).
 */

import { describe, test, expect } from 'vitest';

import {
  SystemClock,
  createSystemClock,
  createManualClock,
} from '../../utility/clock.js';

describe('SystemClock', () => {
  test('now() returns a millisecond timestamp around Date.now()', () => {
    const before = Date.now();
    const t = SystemClock.now();
    const after = Date.now();
    expect(t >= before && t <= after).toBe(true);
  });

  test('setTimeout fires after the requested delay', async () => {
    let fired = false;
    SystemClock.setTimeout(() => {
      fired = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 25));
    expect(fired).toBe(true);
  });

  test('cancel() prevents the callback', async () => {
    let fired = false;
    const t = SystemClock.setTimeout(() => {
      fired = true;
    }, 5);
    t.cancel();
    await new Promise((r) => setTimeout(r, 25));
    expect(fired).toBe(false);
  });

  test('createSystemClock() returns the shared singleton', () => {
    expect(createSystemClock()).toBe(SystemClock);
  });
});

describe('ManualClock — time', () => {
  test('now() starts at `initial` (default 0) and tracks set/advance', () => {
    const clock = createManualClock();
    expect(clock.now()).toBe(0);

    const c2 = createManualClock(1_000);
    expect(c2.now()).toBe(1_000);

    c2.advance(500);
    expect(c2.now()).toBe(1_500);

    c2.set(10);
    expect(c2.now()).toBe(10);
  });
});

describe('ManualClock — timers', () => {
  test('timers do not fire without advance', () => {
    const clock = createManualClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 100);
    expect(fired).toBe(false);
  });

  test('advance(delta) fires timers whose runAt has passed', () => {
    const clock = createManualClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 100);

    clock.advance(99);
    expect(fired).toBe(false);

    clock.advance(1);
    expect(fired).toBe(true);
  });

  test('multiple timers fire in runAt order', () => {
    const clock = createManualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('a'), 100);
    clock.setTimeout(() => order.push('b'), 50);
    clock.setTimeout(() => order.push('c'), 150);

    clock.advance(200);
    expect(order).toEqual(['b', 'a', 'c']);
  });

  test('cancel() before fire prevents the callback', () => {
    const clock = createManualClock();
    let fired = false;
    const t = clock.setTimeout(() => {
      fired = true;
    }, 100);
    t.cancel();
    clock.advance(200);
    expect(fired).toBe(false);
  });

  test('cancel() inside another firing callback is honored', () => {
    const clock = createManualClock();
    let bFired = false;
    let aFired = false;
    const tB = clock.setTimeout(() => {
      bFired = true;
    }, 100);
    clock.setTimeout(() => {
      aFired = true;
      tB.cancel();
    }, 50);

    clock.advance(200);
    expect(aFired).toBe(true);
    expect(bFired).toBe(false);
  });

  test('callbacks scheduled during a firing pass interleave by runAt', () => {
    const clock = createManualClock();
    const order: string[] = [];

    // A fires at 50 → schedules B at +20 (runAt=70). C is already at 100.
    clock.setTimeout(() => {
      order.push('A');
      clock.setTimeout(() => order.push('B'), 20);
    }, 50);
    clock.setTimeout(() => order.push('C'), 100);

    clock.advance(200);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('set(t) does not fire; the next advance(0) sweeps due timers', () => {
    const clock = createManualClock();
    let count = 0;
    clock.setTimeout(() => count++, 50);
    clock.setTimeout(() => count++, 200);
    clock.set(150);
    // No fire from `set` alone.
    expect(count).toBe(0);

    clock.advance(0);
    expect(count).toBe(1);

    clock.advance(100);
    expect(count).toBe(2);
  });

  test('ties at identical runAt fire in insertion order', () => {
    const clock = createManualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('1'), 50);
    clock.setTimeout(() => order.push('2'), 50);
    clock.setTimeout(() => order.push('3'), 50);
    clock.advance(100);
    expect(order).toEqual(['1', '2', '3']);
  });
});
