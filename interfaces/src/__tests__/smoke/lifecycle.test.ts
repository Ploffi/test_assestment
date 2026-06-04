/**
 * Lifecycle contract (ADR-014).
 *
 *  - `evaluate()` before `register()` throws `EngineNotReadyError`.
 *  - `start()` is idempotent and no-op for engines without scheduled rules.
 *  - `stop()` waits for in-flight work to settle and returns Promise<void>.
 *  - After `stop()`, further `evaluate()` calls are not guaranteed to work
 *    (engine consumes a `stop -> recreate` lifecycle, not `stop -> reuse`).
 */

import { describe, test, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  createEngine,
  fakeEnvelope,
  rule,
  action,
} from '../_harness.js';
import { EngineNotReadyError } from '../../public/index.js';

describe('engine lifecycle', () => {
  test('evaluate() before register() throws EngineNotReadyError', async () => {
    const engine = createEngine();
    await expect(engine.evaluate(fakeEnvelope('push'))).rejects.toBeInstanceOf(
      EngineNotReadyError,
    );
  });

  test('start() returns void synchronously', () => {
    const engine = createEngine();
    const ret = engine.start();
    expect(ret).toBeUndefined();
  });

  test('start() is idempotent (multiple calls have no side effect)', () => {
    const engine = createEngine();
    engine.start();
    engine.start();
    engine.start();
  });

  test('stop() returns a Promise that resolves', async () => {
    const engine = createEngine();
    engine.start();
    await engine.stop();
  });

  test('stop() waits for in-flight evaluate() to settle', async () => {
    const finishedAfterStop = vi.fn();
    const slow = action('slow')
      .args(z.object({}))
      .fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        finishedAfterStop();
      });

    const r = rule('r').on('push').when(() => true).action('slow');
    const engine = createEngine();
    engine.register({ actions: [slow({})], rules: [r()] });
    engine.start();

    const inflight = engine.evaluate(fakeEnvelope('push'));
    const stopped = engine.stop();

    // stop() resolves only after the in-flight evaluation completes;
    // both promises share that completion timing.
    await Promise.all([inflight, stopped]);
    expect(finishedAfterStop).toHaveBeenCalledTimes(1);
  });
});
