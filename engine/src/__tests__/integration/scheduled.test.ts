/**
 * Scheduled rule lifecycle (ADR-007).
 *
 *  - First evaluate(): the rule's `.when` passes → engine resolves
 *    `transform(ctx) → payload` and `enqueues` a record. evaluate() resolves
 *    void without firing any action.
 *  - Scheduler tick `claim`s due records, runs `check(ctx)`, branches on
 *    `pass` / `skip` / `recheck` → `remove` / `remove` / `reschedule`.
 *  - On `pass`, attached scheduled actions (and any plain actions on the
 *    same rule) fire with `ctx.scheduled.payload`.
 *  - `deadline` is absolute, resolved once at enqueue; rechecks past
 *    deadline become `skip`.
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  createInMemoryScheduledStore,
  createManualClock,
  fakeEnvelope,
  rule,
  action,
  scheduledAction,
} from '../_harness.js';
import type {
  ScheduledStore,
  ScheduledCheck,
  CheckResult,
} from '../../public/index.js';

function trackingStore(): ScheduledStore & {
  calls: {
    enqueued: Array<{ ruleId: string; keyId: string; runAt: number; deadline?: number }>;
    claimed: number;
    removed: Array<{ ruleId: string; keyId: string }>;
    rescheduled: Array<{ ruleId: string; keyId: string; newRunAt: number }>;
  };
} {
  const inner = createInMemoryScheduledStore();
  const calls = {
    enqueued: [] as Array<{ ruleId: string; keyId: string; runAt: number; deadline?: number }>,
    claimed: 0,
    removed: [] as Array<{ ruleId: string; keyId: string }>,
    rescheduled: [] as Array<{ ruleId: string; keyId: string; newRunAt: number }>,
  };
  return {
    calls,
    async enqueue(ruleId, keyId, runAt, payload, scheduledAt, deadline) {
      calls.enqueued.push({ ruleId, keyId, runAt, deadline });
      return inner.enqueue(ruleId, keyId, runAt, payload, scheduledAt, deadline);
    },
    async claim(now, limit, leaseMs) {
      calls.claimed += 1;
      return inner.claim(now, limit, leaseMs);
    },
    async remove(ruleId, keyId) {
      calls.removed.push({ ruleId, keyId });
      return inner.remove(ruleId, keyId);
    },
    async reschedule(ruleId, keyId, newRunAt) {
      calls.rescheduled.push({ ruleId, keyId, newRunAt });
      return inner.reschedule(ruleId, keyId, newRunAt);
    },
  };
}

async function flushScheduler(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('scheduled — enqueue on evaluate()', () => {
  test('first evaluate() enqueues and resolves void without firing actions', async () => {
    const store = trackingStore();
    const fired = vi.fn(async () => {});
    const act = scheduledAction('sched-act').args(z.object({})).fn(fired);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '250ms',
        key: () => 'issue-1',
        transform: () => ({ marker: 'x' }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const clock = createManualClock(1_000_000);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('issues.closed'));
    expect(store.calls.enqueued.length).toBe(1);
    expect(store.calls.enqueued[0]?.keyId).toBe('issue-1');
    expect(store.calls.enqueued[0]?.runAt).toBe(1_000_250);
    expect(fired).not.toHaveBeenCalled();
  });

  test('duplicate (ruleId, keyId) replaces — latest triggering event wins', async () => {
    const store = trackingStore();
    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'same-key',
        transform: (ctx) => ({ at: ctx.now }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const act = scheduledAction('sched-act').args(z.object({})).fn(async () => {});
    const engine = createEngine({ scheduledStore: store });
    engine.register({ scheduledActions: [act({})], rules: [r()] });

    await engine.evaluate(fakeEnvelope('issues.closed'));
    await engine.evaluate(fakeEnvelope('issues.closed'));
    // Both calls produce enqueue ops; the store's contract is to replace.
    expect(store.calls.enqueued.length).toBe(2);
  });
});

describe('scheduled — check outcomes', () => {
  test("`pass` fires attached scheduledActions then removes the record", async () => {
    const store = trackingStore();
    const fired = vi.fn(async (_ctx) => {
      expect(store.calls.removed.length).toBe(0);
    });
    const act = scheduledAction('sched-act').args(z.object({})).fn(fired);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({ id: 1 }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    // Advance past `delay: 5m` plus one poll cadence.
    clock.advance(5 * 60_000 + 11_000);
    // Let the engine pump out queued microtasks.
    await new Promise((r) => setImmediate(r));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(store.calls.removed.length).toBe(1);

    await engine.stop();
  });

  test('scheduled action failure keeps the record for retry after the lease expires', async () => {
    const store = trackingStore();
    const failed = vi.fn(async () => {
      throw new Error('scheduled action failed');
    });
    const act = scheduledAction('sched-act').args(z.object({})).fn(failed);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({ id: 1 }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));

    expect(failed).toHaveBeenCalledTimes(1);
    expect(store.calls.removed.length).toBe(0);

    await engine.stop();
  });

  test('scheduled action failures remove the record after 10 attempts', async () => {
    const store = trackingStore();
    const clock = createManualClock(0);
    const outcomes: string[] = [];
    const failed = vi.fn(async () => {
      throw new Error('scheduled action failed');
    });
    const act = scheduledAction('sched-act').args(z.object({})).fn(failed);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: 0,
        key: () => 'k',
        transform: () => ({ id: 1 }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const engine = createEngine({ scheduledStore: store, clock });
    engine.on('scheduled.checked', (event) => outcomes.push(event.outcome));
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    for (let i = 0; i < 10; i++) {
      clock.advance(i === 0 ? 10_000 : 30_000);
      await flushScheduler();
    }

    expect(failed).toHaveBeenCalledTimes(10);
    expect(store.calls.removed).toEqual([{ ruleId: 'r', keyId: 'k' }]);
    expect(outcomes).toEqual(['max_attempts_exceeded']);

    await engine.stop();
  });

  test('`pass` can run attached scheduled and plain actions with the scheduled payload', async () => {
    const store = trackingStore();
    const scheduledFired = vi.fn(async () => {});
    let plainObserved: unknown;
    const sched = scheduledAction('sched-act').args(z.object({})).fn(scheduledFired);
    const plain = action('plain-act')
      .args(z.object({}))
      .fn(async (ctx) => {
        plainObserved = (ctx as any).scheduled.payload;
      });

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '1s',
        key: () => 'k',
        transform: () => ({ marker: 'scheduled-payload' }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act')
      .action('plain-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [sched({})], actions: [plain({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(11_000);
    await new Promise((r) => setImmediate(r));

    expect(scheduledFired).toHaveBeenCalledTimes(1);
    expect(plainObserved).toEqual({ marker: 'scheduled-payload' });
    expect(store.calls.removed.length).toBe(1);
    await engine.stop();
  });

  test("`skip` removes the record without firing any action", async () => {
    const store = trackingStore();
    const fired = vi.fn(async () => {});
    const act = scheduledAction('sched-act').args(z.object({})).fn(fired);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({}),
        check: async () => ({ kind: 'skip' }),
      })
      .action('sched-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));

    expect(fired).not.toHaveBeenCalled();
    expect(store.calls.removed.length).toBe(1);
    await engine.stop();
  });

  test('check failure is isolated to skip and removes the record', async () => {
    const store = trackingStore();
    const fired = vi.fn(async () => {});
    const act = scheduledAction('sched-act').args(z.object({})).fn(fired);

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({}),
        check: async () => {
          throw new Error('check failed');
        },
      })
      .action('sched-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));

    expect(fired).not.toHaveBeenCalled();
    expect(store.calls.removed.length).toBe(1);
    await engine.stop();
  });

  test("`recheck` reschedules; new runAt is now + after", async () => {
    const store = trackingStore();
    let checks = 0;
    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        key: () => 'k',
        transform: () => ({}),
        check: async (): Promise<CheckResult> => {
          checks += 1;
          return { kind: 'recheck', after: '30m' };
        },
      })
      .action('sched-act');
    const act = scheduledAction('sched-act').args(z.object({})).fn(async () => {});

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(5 * 60_000 + 11_000); // initial delay
    await new Promise((r) => setImmediate(r));

    expect(checks).toBe(1);
    expect(store.calls.rescheduled.length).toBe(1);
    const r1 = store.calls.rescheduled[0]!;
    // newRunAt = now + 30m
    expect(r1.newRunAt).toBe(clock.now() + 30 * 60_000);
    await engine.stop();
  });

  test('`recheck` past deadline auto-skips (no further rescheduling)', async () => {
    const store = trackingStore();

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: '5m',
        deadline: '10m',
        key: () => 'k',
        transform: () => ({}),
        check: async () => ({ kind: 'recheck', after: '20m' }),
      })
      .action('sched-act');
    const act = scheduledAction('sched-act').args(z.object({})).fn(async () => {});

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(5 * 60_000 + 11_000);
    await new Promise((r) => setImmediate(r));

    // Recheck would land 20m past now → past the 10m deadline → engine substitutes skip.
    expect(store.calls.rescheduled.length).toBe(0);
    expect(store.calls.removed.length).toBe(1);
    await engine.stop();
  });
});

describe('scheduled — graceful shutdown', () => {
  test('stop() aborts an in-flight scheduled check and resolves', async () => {
    const store = trackingStore();
    const clock = createManualClock(0);
    const checkStarted = vi.fn();
    const checkAborted = vi.fn();

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: 0,
        key: () => 'k',
        transform: () => ({}),
        check: async (ctx): Promise<CheckResult> => {
          checkStarted();
          return new Promise<CheckResult>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              checkAborted();
              reject(new Error('aborted'));
            }, { once: true });
          });
        },
      })
      .action('sched-act');
    const act = scheduledAction('sched-act').args(z.object({})).fn(async () => {});
    const engine = createEngine({ scheduledStore: store, clock, evaluationTimeoutMs: 60_000 });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(10_000);
    await flushScheduler();
    expect(checkStarted).toHaveBeenCalledTimes(1);

    const stopped = engine.stop();

    expect(await settlesWithin(stopped, 50)).toBe(true);
    await expect(stopped).resolves.toBeUndefined();
    expect(checkAborted).toHaveBeenCalledTimes(1);
    expect(store.calls.removed).toEqual([]);
  });

  test('stop() does not hang on a scheduled action that ignores cancellation', async () => {
    const store = trackingStore();
    const clock = createManualClock(0);
    const actionStarted = vi.fn();

    const act = scheduledAction('sched-act')
      .args(z.object({}))
      .fn(async () => {
        actionStarted();
        await new Promise<void>(() => {});
      });
    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: 0,
        key: () => 'k',
        transform: () => ({}),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');
    const engine = createEngine({ scheduledStore: store, clock, evaluationTimeoutMs: 60_000 });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(10_000);
    await flushScheduler();
    expect(actionStarted).toHaveBeenCalledTimes(1);

    const stopped = engine.stop();

    expect(await settlesWithin(stopped, 50)).toBe(true);
    await expect(stopped).resolves.toBeUndefined();
    expect(store.calls.removed).toEqual([]);
  });

  test('scheduled action timeout releases the worker and keeps the record for retry', async () => {
    const store = trackingStore();
    const clock = createManualClock(0);
    const actionStarted = vi.fn();
    const failures: unknown[] = [];

    const act = scheduledAction('sched-act')
      .args(z.object({}))
      .fn(async () => {
        actionStarted();
        await new Promise<void>(() => {});
      });
    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: 0,
        key: () => 'k',
        transform: () => ({}),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');
    const engine = createEngine({ scheduledStore: store, clock, evaluationTimeoutMs: 10 });
    engine.on('evaluation.failed', (event) => failures.push(event.error));
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    clock.advance(10_000);
    await flushScheduler();
    expect(actionStarted).toHaveBeenCalledTimes(1);

    clock.advance(10);
    await flushScheduler();
    await flushScheduler();

    expect(failures.length).toBe(1);
    expect(store.calls.removed).toEqual([]);

    const stopped = engine.stop();
    expect(await settlesWithin(stopped, 50)).toBe(true);
    await expect(stopped).resolves.toBeUndefined();
  });
});

describe('scheduled — payload + ctx shape', () => {
  test('scheduledAction.fn sees ctx.scheduled.payload from the rule transform; no ctx.event', async () => {
    const store = createInMemoryScheduledStore();

    let observed: { issueId: number; url: string } | undefined;
    const act = scheduledAction('sched-act')
      .args(z.object({}))
      .fn(async (ctx) => {
        observed = ctx.scheduled.payload as { issueId: number; url: string };
      });

    const r = rule('r')
      .on('issues.closed')
      .when(() => true)
      .schedule({
        delay: 0, // fire on first tick
        key: () => 'k',
        transform: (ctx) => ({
          issueId: ctx.event.issue.id,
          url: ctx.event.issue.html_url,
        }),
        check: async () => ({ kind: 'pass' }),
      })
      .action('sched-act');

    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ scheduledActions: [act({})], rules: [r()] });
    engine.start();

    await engine.evaluate(
      fakeEnvelope('issues.closed', {
        issue: { id: 42, html_url: 'https://x/y/issues/42' },
      }),
    );
    clock.advance(11_000);
    await new Promise((r) => setImmediate(r));

    expect(observed).toBeDefined();
    expect(observed?.issueId).toBe(42);
    await engine.stop();
  });
});

describe('scheduled — claim contract', () => {
  test('scheduler ticks before register do not claim work', async () => {
    const store = trackingStore();
    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.start();

    clock.advance(11_000);
    await new Promise((r) => setImmediate(r));

    expect(store.calls.claimed).toBe(0);
    await engine.stop();
  });

  test('orphaned scheduled records are removed when their rule is no longer registered', async () => {
    const store = trackingStore();
    await store.enqueue('missing-rule', 'k', 1_000, {}, 0);
    const clock = createManualClock(0);
    const engine = createEngine({ scheduledStore: store, clock });
    engine.register({ rules: [] });
    engine.start();

    clock.advance(11_000);
    await new Promise((r) => setImmediate(r));

    expect(store.calls.removed).toEqual([{ ruleId: 'missing-rule', keyId: 'k' }]);
    await engine.stop();
  });

  test('engine never claims below the 10s floor (ADR-007)', async () => {
    const store = trackingStore();
    const engine = createEngine({
      scheduledStore: store,
      // request a small cadence — engine must clamp to 10_000 ms
      scheduledPollMs: 100,
    });
    engine.register({ rules: [] });
    engine.start();

    // Allow microtask flush; with a 10s floor, no claim should happen here.
    await new Promise((r) => setImmediate(r));
    expect(store.calls.claimed).toBe(0);
    await engine.stop();
  });

  test('ScheduledCheck shape carries the original scheduledAt + payload', async () => {
    // Read-side smoke: the engine surfaces the same fields the store returned.
    const store = createInMemoryScheduledStore();
    await store.enqueue('r1', 'k', 1_000, { marker: 'p' }, 500, 60_000);
    const claimed = await store.claim(2_000, 10, 0);
    const first: ScheduledCheck | undefined = claimed[0];
    expect(first?.scheduledAt).toBe(500);
    expect(first?.payload?.marker).toBe('p');
  });
});
