import { describe, expect, test } from 'vitest';

import { canonicalJson } from '../../engine/utility/canonical.js';

describe('canonicalJson', () => {
  test('serializes object cycles without recursing forever', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(canonicalJson(value)).toBe('{"self":"<cycle>"}');
  });

  test('serializes array cycles without recursing forever', () => {
    const value: unknown[] = [];
    value.push(value);

    expect(canonicalJson(value)).toBe('["<cycle>"]');
  });

  test('does not treat shared non-cyclic references as cycles', () => {
    const shared = { id: 1 };

    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"id":1},"b":{"id":1}}');
  });
});
