/**
 * Unit tests for `.when` tree constructors — `all`, `any`, `not`, `use`.
 *
 * These are pure data factories: each call returns a frozen-shape node
 * with the right `kind` discriminator and the children passed in.
 * Evaluation semantics (short-circuit, sequential walk, leaf isolation)
 * live on the engine side per ADR-004 and are not the subject here.
 */

import { describe, test, expect } from 'vitest';

import { all, any, not, use } from '../../utility/combinators.js';

describe('all(...)', () => {
  test('returns an AllNode with kind: "all"', () => {
    const node = all();
    expect(node.kind).toBe('all');
  });

  test('preserves children in insertion order', () => {
    const f = () => true;
    const g = () => false;
    const node = all(f, g);
    expect(node.children.length).toBe(2);
    expect(node.children[0]).toBe(f);
    expect(node.children[1]).toBe(g);
  });

  test('accepts zero children (degenerate "all of nothing")', () => {
    const node = all();
    expect(node.children.length).toBe(0);
  });

  test('accepts nested combinator children', () => {
    const inner = any(() => true);
    const outer = all(inner, not(() => false));
    expect(outer.kind).toBe('all');
    expect(outer.children.length).toBe(2);
    expect((outer.children[0] as { kind: string }).kind).toBe('any');
    expect((outer.children[1] as { kind: string }).kind).toBe('not');
  });
});

describe('any(...)', () => {
  test('returns an AnyNode with kind: "any"', () => {
    const node = any();
    expect(node.kind).toBe('any');
  });

  test('preserves children in insertion order', () => {
    const f = () => true;
    const g = () => false;
    const node = any(f, g);
    expect(node.children[0]).toBe(f);
    expect(node.children[1]).toBe(g);
  });
});

describe('not(child)', () => {
  test('returns a NotNode with kind: "not" wrapping the child', () => {
    const child = () => true;
    const node = not(child);
    expect(node.kind).toBe('not');
    expect(node.child).toBe(child);
  });

  test('can wrap a use(...) reference', () => {
    const ref = use('some_predicate', { x: 1 });
    const node = not(ref);
    expect(node.kind).toBe('not');
    expect((node.child as { kind: string }).kind).toBe('use');
  });
});

describe('use(name, args?)', () => {
  test('returns a UseRef with the given name and args', () => {
    const ref = use('is_team_member', { team: 'core', login: 'alice' });
    expect(ref.kind).toBe('use');
    expect(ref.name).toBe('is_team_member');
    expect(ref.args).toEqual({ team: 'core', login: 'alice' });
  });

  test('args defaults to an empty object when omitted', () => {
    const ref = use('p');
    expect(ref.kind).toBe('use');
    expect(ref.name).toBe('p');
    expect(ref.args).toEqual({});
  });

  test('callback args are preserved by reference (engine resolves at evaluate time)', () => {
    const cb = (ctx: { event: { foo: string } }) => ctx.event.foo;
    const ref = use('p', { login: cb });
    expect((ref.args as { login: unknown }).login).toBe(cb);
  });
});

describe('node shape — discriminator narrowing', () => {
  test('every node carries exactly its `kind` discriminator', () => {
    const a = all();
    const o = any();
    const n = not(() => true);
    const u = use('p');
    expect(a.kind).toBe('all');
    expect(o.kind).toBe('any');
    expect(n.kind).toBe('not');
    expect(u.kind).toBe('use');
  });
});
