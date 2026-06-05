/**
 * Unit tests for `createConsoleLogger`.
 *
 * The contract: every method exists, writes to the provided console target,
 * and `child(bindings)` carries scoped fields forward.
 */

import { describe, test, expect } from 'vitest';

import { createConsoleLogger, type ConsoleLoggerTarget } from '../../public/logger.js';

type Call = { level: keyof ConsoleLoggerTarget; args: unknown[] };

function makeTarget(): { target: ConsoleLoggerTarget; calls: Call[] } {
  const calls: Call[] = [];
  const target: ConsoleLoggerTarget = {
    debug: (...args: unknown[]) => { calls.push({ level: 'debug', args }); },
    info: (...args: unknown[]) => { calls.push({ level: 'info', args }); },
    warn: (...args: unknown[]) => { calls.push({ level: 'warn', args }); },
    error: (...args: unknown[]) => { calls.push({ level: 'error', args }); },
  };
  return { target, calls };
}

describe('createConsoleLogger', () => {
  test('exposes the Pino-compatible method surface', () => {
    const log = createConsoleLogger(makeTarget().target);
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  test('writes object-first entries to the console target', () => {
    const { target, calls } = makeTarget();
    const log = createConsoleLogger(target);

    expect(log.debug({ k: 'v' })).toBeUndefined();
    expect(log.info({ k: 'v' }, 'hello')).toBeUndefined();
    expect(log.warn({}, 'warn')).toBeUndefined();
    expect(log.error({ err: new Error('x') }, 'oops')).toBeUndefined();

    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ level: 'debug', args: [{ k: 'v' }] });
    expect(calls[1]).toMatchObject({ level: 'info', args: [{ k: 'v' }, 'hello'] });
    expect(calls[2]).toMatchObject({ level: 'warn', args: [{}, 'warn'] });
    expect(calls[3]?.level).toBe('error');
  });

  test('child(bindings) returns a fully-shaped Logger and includes bindings', () => {
    const { target, calls } = makeTarget();
    const root = createConsoleLogger(target);
    const child = root.child({ deliveryId: 'abc' });

    expect(typeof child.debug).toBe('function');
    expect(typeof child.child).toBe('function');
    child.info({ nested: true }, 'child log');

    expect(calls).toEqual([
      { level: 'info', args: [{ deliveryId: 'abc', nested: true }, 'child log'] },
    ]);
  });

  test('child().child() chains without error', () => {
    const { target, calls } = makeTarget();
    const a = createConsoleLogger(target);
    const b = a.child({ a: 1 });
    const c = b.child({ b: 2 });

    c.warn({ from: 'c' });

    expect(calls).toEqual([
      { level: 'warn', args: [{ a: 1, b: 2, from: 'c' }] },
    ]);
  });
});
