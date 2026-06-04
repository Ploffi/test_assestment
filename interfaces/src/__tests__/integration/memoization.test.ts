/**
 * Per-event predicate memoization (ADR-004).
 *
 * Within one `evaluate(envelope)` call, the same `use(name, args)` across
 * multiple rules resolves to one `.fn` invocation — DataLoader pattern.
 * Cross-event: no sharing; the TTL cache inside `IntegrationAdapter`
 * handles cross-event reuse (ADR-005).
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  predicate,
  action,
  use,
} from '../_harness.js';
import { notifySlack } from '../_fixtures.js';

describe('per-event predicate memoization', () => {
  test('same (name, args) across rules — invoked once per event', async () => {
    const fn = vi.fn(async () => true);
    const shared = predicate('shared')
      .args(z.object({ key: z.string() }))
      .fn(fn);

    const r1 = rule('r1')
      .on('push')
      .when(use('shared', { key: 'k' }))
      .action('notify-slack');
    const r2 = rule('r2')
      .on('push')
      .when(use('shared', { key: 'k' }))
      .action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [shared()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [r1(), r2()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('same name, different args — one call per distinct args hash', async () => {
    const fn = vi.fn(async () => true);
    const p = predicate('p')
      .args(z.object({ x: z.number() }))
      .fn(fn);

    const r1 = rule('r1').on('push').when(use('p', { x: 1 })).action('notify-slack');
    const r2 = rule('r2').on('push').when(use('p', { x: 2 })).action('notify-slack');
    const r3 = rule('r3').on('push').when(use('p', { x: 1 })).action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [p()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [r1(), r2(), r3()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    // { x: 1 } shared between r1+r3, { x: 2 } separate. Two unique signatures.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('memoization does NOT span events (different deliveries re-invoke)', async () => {
    const fn = vi.fn(async () => true);
    const p = predicate('p').args(z.object({})).fn(fn);
    const r = rule('r').on('push').when(use('p')).action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [p()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [r()],
    });

    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-A'));
    await engine.evaluate(fakeEnvelope('push', undefined, 'delivery-B'));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('args ordering does not affect the memo key (recursive canonicalization)', async () => {
    const fn = vi.fn(async () => true);
    const p = predicate('p')
      .args(z.object({ a: z.number(), b: z.number() }))
      .fn(fn);

    const r1 = rule('r1')
      .on('push')
      .when(use('p', { a: 1, b: 2 }))
      .action('notify-slack');
    const r2 = rule('r2')
      .on('push')
      .when(use('p', { b: 2, a: 1 }))
      .action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [p()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [r1(), r2()],
    });
    await engine.evaluate(fakeEnvelope('push'));
    // Same args, different key order — must collapse into one call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('memoization survives a `false` result — second caller awaits the same outcome', async () => {
    const fn = vi.fn(async () => false);
    const p = predicate('p').args(z.object({})).fn(fn);

    const r1 = rule('r1').on('push').when(use('p')).action('notify-slack');
    const r2 = rule('r2').on('push').when(use('p')).action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [p()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [r1(), r2()],
    });
    await engine.evaluate(fakeEnvelope('push'));
    // Both rules evaluate to false from one .fn call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a predicate throw memoizes the isolated `false` (ADR-004)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const p = predicate('p').args(z.object({})).fn(fn);
    const actFn = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(actFn);

    const r1 = rule('r1').on('push').when(use('p')).action('a');
    const r2 = rule('r2').on('push').when(use('p')).action('a');

    const engine = createEngine();
    engine.register({
      predicates: [p()],
      actions: [a({})],
      rules: [r1(), r2()],
    });
    await engine.evaluate(fakeEnvelope('push'));
    // .fn called once across both rules; both leaves resolve to false; no action fires.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(actFn).not.toHaveBeenCalled();
  });
});
