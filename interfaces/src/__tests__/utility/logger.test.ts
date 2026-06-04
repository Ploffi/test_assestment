/**
 * Unit tests for `createNoopLogger` (ADR-011).
 *
 * The contract: every method exists, none throw, none produce output.
 * `child(bindings)` returns a logger with the same shape.
 */

import { describe, test, expect } from 'vitest';

import { createNoopLogger } from '../../utility/logger.js';

describe('createNoopLogger', () => {
  test('exposes the Pino-compatible method surface', () => {
    const log = createNoopLogger();
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  test('calls never throw and return undefined', () => {
    const log = createNoopLogger();
    expect(log.debug({ k: 'v' })).toBeUndefined();
    expect(log.info({ k: 'v' }, 'hello')).toBeUndefined();
    expect(log.warn({}, 'warn')).toBeUndefined();
    expect(log.error({ err: new Error('x') }, 'oops')).toBeUndefined();
  });

  test('child(bindings) returns a fully-shaped Logger', () => {
    const root = createNoopLogger();
    const child = root.child({ deliveryId: 'abc' });
    expect(typeof child.debug).toBe('function');
    expect(typeof child.child).toBe('function');
    // The contract permits — but does not require — child to be a
    // distinct instance; we only care that the shape is intact.
    child.info({ nested: true }, 'still no-op');
  });

  test('child().child() chains without error', () => {
    const a = createNoopLogger();
    const b = a.child({ a: 1 });
    const c = b.child({ b: 2 });
    c.warn({ from: 'c' });
  });
});
