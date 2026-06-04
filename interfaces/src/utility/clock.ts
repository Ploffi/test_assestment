/**
 * Clock implementations (ADR-015).
 *
 *  - `SystemClock` — real wall clock + Node timers.
 *  - `ManualClock` — test clock; pending timers fire only on `advance(...)`.
 *
 * Engine code calls `clock.now()` and `clock.setTimeout(...)` instead of
 * `Date.now()` / global `setTimeout`, so tests can drive time
 * deterministically.
 */

import type { Clock, ManualClock, Timer } from '../public/clock.js';

/* ============================================================ *
 * SystemClock — real time, real timers
 * ============================================================ */

/**
 * Shared singleton — the engine creates one default `Clock` and reuses it
 * across subsystems; cloning produces no useful difference.
 */
export const SystemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb: () => void, delayMs: number): Timer => {
    const t = setTimeout(cb, delayMs);
    return {
      cancel(): void {
        clearTimeout(t);
      },
    };
  },
};

/** Returns the shared `SystemClock` instance. */
export function createSystemClock(): Clock {
  return SystemClock;
}

/* ============================================================ *
 * ManualClock — test clock
 *
 * `advance(deltaMs)` walks the pending-timer queue in `runAt` order,
 * firing each whose deadline now lies in the past. Callbacks scheduled
 * DURING a firing callback are inserted into the same pass — they fire
 * inside the same `advance` if they too are due.
 *
 * `set(timeMs)` jumps the cursor without firing; the next `advance(...)`
 * — including `advance(0)` — does the sweep.
 *
 * Cancellation marks the timer as inert; the queue is GC'd lazily.
 * ============================================================ */

interface PendingTimer {
  readonly id: number;
  runAt: number;
  readonly cb: () => void;
  cancelled: boolean;
}

export function createManualClock(initial: number = 0): ManualClock {
  let current = initial;
  let nextId = 1;
  const pending: PendingTimer[] = [];

  // Walk pending up to `target`, stepping `current` to each timer's `runAt`
  // before invoking its callback. Discrete-event-simulator style: a callback
  // that schedules another timer with delay D ends up with `runAt = thisFire + D`,
  // not `runAt = target + D`. After the sweep, `current` snaps to `target`.
  const sweepUpTo = (target: number): void => {
    while (true) {
      pending.sort((a, b) => a.runAt - b.runAt || a.id - b.id);
      const head = pending[0];
      if (!head) break;
      if (head.cancelled) {
        pending.shift();
        continue;
      }
      if (head.runAt > target) break;
      pending.shift();
      current = head.runAt;
      head.cb();
    }
    current = target;
  };

  return {
    now(): number {
      return current;
    },
    setTimeout(cb: () => void, delayMs: number): Timer {
      const timer: PendingTimer = {
        id: nextId++,
        runAt: current + delayMs,
        cb,
        cancelled: false,
      };
      pending.push(timer);
      return {
        cancel(): void {
          timer.cancelled = true;
        },
      };
    },
    set(timeMs: number): void {
      current = timeMs;
    },
    advance(deltaMs: number): void {
      sweepUpTo(current + deltaMs);
    },
  };
}
