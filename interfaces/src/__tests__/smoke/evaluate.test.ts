/**
 * `engine.evaluate` contract (ADR-014).
 *
 *  - Returns `Promise<void>`.
 *  - Resolves on success or clean skip (no rule matched / `.when` false /
 *    aggregation below threshold / scheduled enqueued).
 *  - Rejects when an action throws (including aggregated errors when many
 *    actions threw in parallel).
 *  - Does NOT reject for predicate errors — those isolate to `false` per
 *    ADR-004 and remain a logging concern.
 *  - `EvaluateOptions.signal` composes with the engine's evaluation
 *    deadline.
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
  use,
} from '../_harness.js';
import {
  notifySlack,
  infraPrFromOutsider,
  isTeamMember,
  touchesPaths,
  isHostileComment,
  hostilePrComment,
} from '../_fixtures.js';

describe('engine.evaluate — happy paths resolve void', () => {
  test('resolves when no rule matches (Phase 1 dispatch empty)', async () => {
    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#x' })],
      predicates: [isTeamMember(), touchesPaths()],
      rules: [infraPrFromOutsider()],
    });

    // 'push' isn't subscribed by any registered rule.
    const result = await engine.evaluate(fakeEnvelope('push'));
    expect(result).toBeUndefined();
  });

  test('resolves when `.when` returns false', async () => {
    const alwaysFalse = rule('always-false')
      .on('pull_request.opened')
      .when(() => false)
      .action('notify-slack');

    const fn = vi.fn(async () => {});
    const sideAction = action('side')
      .args(z.object({}))
      .fn(fn);

    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#x' }), sideAction({})],
      rules: [alwaysFalse()],
    });

    const result = await engine.evaluate(fakeEnvelope('pull_request.opened'));
    expect(result).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  test('resolves when matched actions succeed', async () => {
    const fn = vi.fn(async () => {});
    const ok = action('ok')
      .args(z.object({}))
      .fn(fn);
    const r = rule('r')
      .on('push')
      .when(() => true)
      .action('ok');

    const engine = createEngine();
    engine.register({
      actions: [ok({})],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('engine.evaluate — rejects on action failure', () => {
  test('rejects when a single matched action throws', async () => {
    const boom = action('boom')
      .args(z.object({}))
      .fn(async () => {
        throw new Error('boom');
      });
    const r = rule('r').on('push').when(() => true).action('boom');

    const engine = createEngine();
    engine.register({ actions: [boom({})], rules: [r()] });

    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toThrow(/boom/);
  });

  test('rejects AFTER all parallel actions settle (one fails, others run)', async () => {
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
    // Every sibling action ran despite B's failure.
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
    expect(cFn).toHaveBeenCalledTimes(1);
  });

  test('aggregates multiple parallel action throws into one rejection', async () => {
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
    // Per ADR-014: `AggregateError` when the runtime supports it, with
    // every individual failure in `errors`.
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof AggregateError) {
      expect(caught.errors.length).toBe(2);
    }
  });
});

describe('engine.evaluate — predicate errors do NOT reject', () => {
  test('a predicate throw isolates to a `false` leaf (ADR-004)', async () => {
    const flaky = predicate('flaky')
      .args(z.object({}))
      .fn(async () => {
        throw new Error('predicate exploded');
      });

    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);

    const r = rule('r')
      .on('push')
      .when(use('flaky'))
      .action('a');

    const engine = createEngine();
    engine.register({ predicates: [flaky()], actions: [a({})], rules: [r()] });

    // Resolves void; predicate's throw was isolated.
    await engine.evaluate(fakeEnvelope('push'));
    // Action did not fire — leaf was treated as false.
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('engine.evaluate — cancellation', () => {
  test('caller AbortSignal composes with engine deadline', async () => {
    const slow = action('slow')
      .args(z.object({}))
      .fn(
        (ctx) =>
          new Promise<void>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );

    const r = rule('r').on('push').when(() => true).action('slow');
    const engine = createEngine();
    engine.register({ actions: [slow({})], rules: [r()] });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);

    await expect(
      engine.evaluate(fakeEnvelope('push'), { signal: ac.signal }),
    ).rejects.toThrow();
  });

  test('per-evaluation timeout rejects (ADR-014)', async () => {
    const wedged = action('wedged')
      .args(z.object({}))
      .fn(() => new Promise<void>(() => {}));

    const r = rule('r').on('push').when(() => true).action('wedged');
    const engine = createEngine({ evaluationTimeoutMs: 10 });
    engine.register({ actions: [wedged({})], rules: [r()] });

    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toThrow();
  });

  test('late predicate resolution after timeout does not launch actions', async () => {
    const clock = createManualClock(0);
    let resolvePredicate: ((value: boolean) => void) | undefined;
    const slow = predicate('slow')
      .args(z.object({}))
      .fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePredicate = resolve;
          }),
      );
    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);
    const r = rule('r').on('push').when(use('slow')).action('a');

    const engine = createEngine({ clock, evaluationTimeoutMs: 10 });
    engine.register({ predicates: [slow({})], actions: [a({})], rules: [r()] });

    const evaluation = engine.evaluate(fakeEnvelope('push'));
    clock.advance(10);
    await expect(evaluation).rejects.toThrow(/evaluation timeout|aborted/);

    resolvePredicate?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('engine.evaluate — args validation', () => {
  test('invalid merged action args reject and do not invoke the action', async () => {
    const fired = vi.fn(async () => {});
    const a = action('a')
      .args(z.object({ channel: z.string() }))
      .fn(fired);
    const r = rule('r')
      .on('push')
      .when(() => true)
      .action('a', { channel: 123 });

    const engine = createEngine();
    engine.register({ actions: [a({})], rules: [r()] });

    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toThrow();
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('engine.evaluate — logger scoping', () => {
  test('action ctx.logger is child-bound with deliveryId, ruleId, and actionName', async () => {
    const makeLogger = (bindings: Record<string, unknown> = {}) => ({
      bindings,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child(next: object) {
        return makeLogger({ ...bindings, ...next });
      },
    });
    let observed: Record<string, unknown> | undefined;
    const a = action('a')
      .args(z.object({}))
      .fn(async (ctx) => {
        observed = (ctx.logger as unknown as { bindings: Record<string, unknown> }).bindings;
      });
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine({ logger: makeLogger() });
    engine.register({ actions: [a({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-logger'));

    expect(observed).toMatchObject({
      deliveryId: 'delivery-logger',
      ruleId: 'r',
      actionName: 'a',
    });
  });
});

describe('engine.evaluate — type narrowing on `.on(...)`', () => {
  test('ctx.event inside predicate/action narrows by the rule subscriber', async () => {
    // Compile-only check: this is the contract that `.on('issue_comment.created')`
    // narrows `ctx.event` to `IssueCommentCreatedEvent` (a comment payload).
    const engine = createEngine();
    engine.register({
      predicates: [isHostileComment({ minCommentLength: 100 })],
      actions: [notifySlack({ channel: '#mod' })],
      rules: [hostilePrComment({ allowedAuthors: ['Marat'] })],
    });

    await engine.evaluate(fakeEnvelope('issue_comment.created'));
  });
});
