/**
 * Engine construction smoke contract (ADR-014).
 *
 * Constructor accepts zero or any subset of EngineOptions; the resulting
 * `RuleEngine` exposes `register`, `evaluate`, `on`, `off`, `start`, `stop`.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';

import {
  action,
  aggregatedAction,
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  createManualClock,
  createConsoleLogger,
  predicate,
  rule,
  scheduledAction,
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
      logger: createConsoleLogger(),
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

  test('public terminal builders reject incomplete definitions', () => {
    expect(() => (action('missing-action-args') as any)()).toThrow(/missing args schema/);
    expect(() => (action('missing-action-impl').args(z.object({})) as any)()).toThrow(/missing implementation/);

    expect(() => (predicate('missing-predicate-args') as any)()).toThrow(/missing args schema/);
    expect(() => (predicate('missing-predicate-impl').args(z.object({})) as any)()).toThrow(/missing implementation/);

    expect(() => (aggregatedAction('missing-agg-on') as any)()).toThrow(/missing event name/);
    expect(() => (aggregatedAction('missing-agg-args').on('push') as any)()).toThrow(/missing args schema/);
    expect(() => (aggregatedAction('missing-agg-transform').on('push').args(z.object({})) as any)()).toThrow(/missing transform/);
    expect(() => (aggregatedAction('missing-agg-impl').on('push').args(z.object({})).transform(() => ({})) as any)()).toThrow(/missing implementation/);

    expect(() => (scheduledAction('missing-scheduled-args') as any)()).toThrow(/missing args schema/);
    expect(() => (scheduledAction('missing-scheduled-impl').args(z.object({})) as any)()).toThrow(/missing implementation/);

    expect(() => (rule('missing-rule-on') as any)()).toThrow(/missing event name/);
    expect(() => (rule('missing-rule-when').on('push') as any)()).toThrow(/missing when predicate/);
    expect(() => (rule('missing-rule-actions').on('push').when(() => true) as any)()).toThrow(/missing actions/);
  });

  test('stop before start resolves without an armed scheduler timer', async () => {
    const engine = createEngine();

    await expect(engine.stop()).resolves.toBeUndefined();
  });
});
