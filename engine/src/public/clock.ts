/**
 * Cancellable timer handle returned by `Clock.setTimeout` (ADR-015).
 */
export interface Timer {
  cancel(): void;
}

/**
 * Injectable time source (ADR-015).
 *
 * Engine code never calls global `Date.now()` or `setTimeout` directly;
 * it goes through this interface so tests can pin time with a fake clock.
 *
 * Default implementation is `SystemClock` — real wall clock + Node timers.
 */
export interface Clock {
  /** Current time, ms since epoch. */
  now(): number;
  /** Schedule `cb` to run after `delayMs`. Returns a cancellable handle. */
  setTimeout(cb: () => void, delayMs: number): Timer;
}

/**
 * Test-clock shape. The engine accepts any implementation through
 * `EngineOptions.clock`; the package's own test implementation lives under
 * `src/__tests__` so it is not part of the runtime bundle.
 *
 * `advance(ms)` walks queued timeouts in `runAt` order, firing each whose
 * deadline now lies in the past. Callbacks scheduled during a firing
 * callback are inserted into the same advance pass.
 */
export interface ManualClock extends Clock {
  set(timeMs: number): void;
  advance(deltaMs: number): void;
}
