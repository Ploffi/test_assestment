/**
 * `.when` tree constructors (ADR-002, ADR-004).
 *
 * Pure data factories — they don't evaluate anything, just produce the
 * node objects the engine walks at evaluate time. Predicate resolution,
 * memoization, and short-circuit semantics live on the engine side
 * (ADR-004).
 */

import type {
  AllNode,
  AnyNode,
  NotNode,
  UseRef,
  WhenNode,
} from '../public/combinators.js';
import type { UseFactoryArgValue } from '../public/builders.js';
import type { AnyEventPayload } from '../public/webhook.js';

export function all<E extends AnyEventPayload, A>(
  ...children: ReadonlyArray<WhenNode<E, A>>
): AllNode<E, A> {
  return { kind: 'all', children };
}

export function any<E extends AnyEventPayload, A>(
  ...children: ReadonlyArray<WhenNode<E, A>>
): AnyNode<E, A> {
  return { kind: 'any', children };
}

export function not<E extends AnyEventPayload, A>(
  child: WhenNode<E, A>,
): NotNode<E, A> {
  return { kind: 'not', child };
}

export function use(
  name: string,
  args?: { readonly [key: string]: UseFactoryArgValue },
): UseRef {
  return {
    kind: 'use',
    name,
    args: (args ?? {}) as Record<string, unknown>,
  };
}
