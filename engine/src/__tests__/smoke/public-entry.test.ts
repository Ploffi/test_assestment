import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  action,
  createEngine,
  rule,
} from '../../index.js';
import { fakeEnvelope } from '../_helpers.js';

describe('package root entry', () => {
  test('exports runtime builders and createEngine', async () => {
    const fired = vi.fn(async () => {});
    const a = action('a').args(z.object({})).fn(fired);
    const r = rule('r').on('push').when(() => true).action('a');
    const engine = createEngine();

    engine.register({ actions: [a({})], rules: [r()] });
    await engine.evaluate(fakeEnvelope('push'));

    expect(fired).toHaveBeenCalledTimes(1);
  });

  test('builders allow reordered settings and last setting wins', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const a = action('a')
      .fn(first)
      .args(z.object({ value: z.string() }))
      .fn(second);
    const r = rule('r')
      .action('a', { value: 'ok' })
      .on('issues.opened')
      .when(() => false)
      .on('push')
      .when(() => true);
    const engine = createEngine();

    engine.register({ actions: [a()], rules: [r()] });
    await engine.evaluate(fakeEnvelope('issues.opened'));
    await engine.evaluate(fakeEnvelope('push'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
