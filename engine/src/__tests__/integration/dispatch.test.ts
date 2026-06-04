/**
 * Phase-1 dispatch by `.on(eventName)` (ADR-004).
 *
 *  - Rules registered for one event variant pay nothing for unrelated events
 *    (no `.when` invocation; no `.fn` invocation).
 *  - When multiple rules subscribe to the same event, all are evaluated.
 *  - Discriminator format is `<event>.<action>` for events with an
 *    `action` field; bare `<event>` for those without (e.g., `push`).
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  predicate,
  use,
} from '../_harness.js';
import { notifySlack } from '../_fixtures.js';

describe('phase-1 dispatch', () => {
  test('non-subscribing rules are not evaluated', async () => {
    const fnA = vi.fn(async () => true);
    const fnB = vi.fn(async () => true);
    const pA = predicate('p_a').args(z.object({})).fn(fnA);
    const pB = predicate('p_b').args(z.object({})).fn(fnB);

    const rA = rule('rA').on('pull_request.opened').when(use('p_a')).action('notify-slack');
    const rB = rule('rB').on('issues.closed').when(use('p_b')).action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [pA(), pB()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [rA(), rB()],
    });

    await engine.evaluate(fakeEnvelope('pull_request.opened'));
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();

    await engine.evaluate(fakeEnvelope('issues.closed'));
    expect(fnA).toHaveBeenCalledTimes(1); // unchanged
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  test('multiple rules on the same event are all evaluated', async () => {
    const a = vi.fn(async () => true);
    const b = vi.fn(async () => true);
    const pA = predicate('a').args(z.object({})).fn(a);
    const pB = predicate('b').args(z.object({})).fn(b);

    const rA = rule('rA').on('push').when(use('a')).action('notify-slack');
    const rB = rule('rB').on('push').when(use('b')).action('notify-slack');

    const engine = createEngine();
    engine.register({
      predicates: [pA(), pB()],
      actions: [notifySlack({ channel: '#x' })],
      rules: [rA(), rB()],
    });

    await engine.evaluate(fakeEnvelope('push'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('event without `action` field uses bare name discriminator (e.g., "push")', async () => {
    const r = rule('r').on('push').when(() => true).action('notify-slack');
    const engine = createEngine();
    engine.register({
      actions: [notifySlack({ channel: '#x' })],
      rules: [r()],
    });
    await engine.evaluate(fakeEnvelope('push'));
  });
});
