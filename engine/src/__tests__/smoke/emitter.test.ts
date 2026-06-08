/**
 * `engine.on` / `engine.off` typed emitter contract (ADR-011).
 *
 *  - `on(name, cb)` narrows `cb`'s payload to the matching `EngineEventMap`
 *    entry — verified by accessing fields without casts.
 *  - `off(name, cb)` removes the listener (no further invocations after).
 *  - Engine emits at the documented seams; the consumer counts.
 *
 * These tests exercise type narrowing AND runtime subscribe / unsubscribe.
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  action,
} from '../_harness.js';
import { notifySlack } from '../_fixtures.js';
import type {
  RuleMatchedEvent,
  PredicateEvaluatedEvent,
  ExternalCallEvent,
  AggregateAppendedEvent,
  ScheduledEnqueuedEvent,
  ScheduledCheckedEvent,
  EvaluationCompletedEvent,
  EvaluationFailedEvent,
  RuleSkippedEvent,
} from '../../public/index.js';

describe('engine.on — payload narrowing', () => {
  test('rule.matched payload exposes deliveryId / ruleId / elapsedMs', () => {
    const engine = createEngine();
    engine.on('rule.matched', (e: RuleMatchedEvent) => {
      const _id: string = e.ruleId;
      const _delivery: string = e.deliveryId;
      const _elapsed: number = e.elapsedMs;
      void _id;
      void _delivery;
      void _elapsed;
    });
  });

  test('predicate.evaluated payload exposes result + cached flag', () => {
    const engine = createEngine();
    engine.on('predicate.evaluated', (e: PredicateEvaluatedEvent) => {
      const _result: boolean = e.result;
      const _cached: boolean = e.cached;
      void _result;
      void _cached;
    });
  });

  test('external.call payload exposes cacheHit + breakerState', () => {
    const engine = createEngine();
    engine.on('external.call', (e: ExternalCallEvent) => {
      const _hit: boolean = e.cacheHit;
      const _state: 'closed' | 'open' | 'half-open' = e.breakerState;
      void _hit;
      void _state;
    });
  });

  test('aggregate.appended payload carries ruleId/actionId/keyId/count', () => {
    const engine = createEngine();
    engine.on('aggregate.appended', (e: AggregateAppendedEvent) => {
      const _key: string = e.keyId;
      const _count: number = e.count;
      void _key;
      void _count;
    });
  });

  test('scheduled.enqueued payload omits deliveryId (ADR-011)', () => {
    const engine = createEngine();
    engine.on('scheduled.enqueued', (e: ScheduledEnqueuedEvent) => {
      const _key: string = e.keyId;
      const _runAt: number = e.runAt;
      void _key;
      void _runAt;
      // @ts-expect-error: no deliveryId at check time
      void e.deliveryId;
    });
  });

  test('scheduled.checked payload carries outcome union', () => {
    const engine = createEngine();
    engine.on('scheduled.checked', (e: ScheduledCheckedEvent) => {
      const _outcome: 'pass' | 'skip' | 'recheck' | 'deadline_exceeded' | 'max_attempts_exceeded' =
        e.outcome;
      void _outcome;
    });
  });

  test('evaluation.completed / .failed are scoped to one delivery', () => {
    const engine = createEngine();
    engine.on('evaluation.completed', (e: EvaluationCompletedEvent) => {
      const _matched: number = e.matchedCount;
      const _delivery: string = e.deliveryId;
      void _matched;
      void _delivery;
    });
    engine.on('evaluation.failed', (e: EvaluationFailedEvent) => {
      const _err: unknown = e.error;
      void _err;
    });
  });

  test('rule.skipped reason narrows to the documented union', () => {
    const engine = createEngine();
    engine.on('rule.skipped', (e: RuleSkippedEvent) => {
      const _reason: 'when-false' | 'aggregate-below-threshold' | 'scheduled-enqueued' =
        e.reason;
      void _reason;
    });
  });

  test('unknown event names fail at compile time', () => {
    const engine = createEngine();
    // @ts-expect-error: 'not.a.real.event' is not a key of EngineEventMap.
    engine.on('not.a.real.event', () => {});
  });
});

describe('engine.on / engine.off — subscribe lifecycle', () => {
  test('off(name, cb) removes the listener', async () => {
    const cb = vi.fn((_e: EvaluationCompletedEvent) => {});

    const r = rule('r').on('push').when(() => true).action('notify-slack');
    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#x' })],
      rules: [r()],
    });

    engine.on('evaluation.completed', cb);
    await engine.evaluate(fakeEnvelope('push'));
    expect(cb).toHaveBeenCalledTimes(1);

    engine.off('evaluation.completed', cb);
    await engine.evaluate(fakeEnvelope('push'));
    // No additional invocations after off().
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('multiple subscribers all fire on the same event', async () => {
    const a = vi.fn((_e: RuleMatchedEvent) => {});
    const b = vi.fn((_e: RuleMatchedEvent) => {});

    const aRule = action('a').args(z.object({})).fn(async () => {});
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();
    engine.register({ actions: [aRule({})], rules: [r()] });

    engine.on('rule.matched', a);
    engine.on('rule.matched', b);

    await engine.evaluate(fakeEnvelope('push'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
