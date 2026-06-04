/**
 * Clock implementations (ADR-015).
 *
 *  - `SystemClock` — real wall clock + Node timers.
 *
 * Engine code calls `clock.now()` and `clock.setTimeout(...)` instead of
 * `Date.now()` / global `setTimeout`, so tests can drive time
 * deterministically.
 */

import type { Clock, Timer } from '../public/clock.js';

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
