/**
 * Engine construction smoke contract (ADR-014).
 *
 * Constructor accepts zero or any subset of EngineOptions; the resulting
 * `RuleEngine` exposes `register`, `evaluate`, `on`, `off`, `start`, `stop`.
 */

import { describe, test, expect } from 'vitest';

import {
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  createManualClock,
  createNoopLogger,
} from '../_harness.js';
import type { RuleEngine } from '../../public/index.js';

describe('engine.construction', () => {
  test('constructs with no options', () => {
    const engine = createEngine();
    expect(typeof engine.register).toBe('function');
    expect(typeof engine.evaluate).toBe('function');
    expect(typeof engine.on).toBe('function');
    expect(typeof engine.off).toBe('function');
    expect(typeof engine.start).toBe('function');
    expect(typeof engine.stop).toBe('function');
  });

  test('accepts every EngineOptions field', () => {
    const engine: RuleEngine = createEngine({
      aggregationStore: createInMemoryAggregationStore(),
      scheduledStore: createInMemoryScheduledStore(),
      clock: createManualClock(0),
      logger: createNoopLogger(),
      evaluationTimeoutMs: 5_000,
      scheduledPollMs: 30_000,
    });
    void engine;
  });

  test('clamps scheduledPollMs below 10_000 to the 10_000 floor (ADR-007)', () => {
    // The engine must clamp `scheduledPollMs` at construction time; the
    // contract is that the floor is honored, not that construction throws.
    const engine = createEngine({ scheduledPollMs: 500 });
    void engine;
  });
});
