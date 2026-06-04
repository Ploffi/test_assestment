/**
 * `.when(...)` tree shapes (ADR-002, ADR-004).
 *
 * Composed by `all` / `any` / `not` over leaves that are either inline
 * `(ctx) => boolean | Promise<boolean>` functions or `use(name, args)`
 * references to a registered predicate.
 */

import type { BaseCtx } from './ctx.js';
import type { AnyEventPayload } from './webhook.js';

/** Inline boolean leaf — evaluated with the rule's ctx (no `use(...)` indirection). */
export type InlinePredicate<E extends AnyEventPayload, RuleArgs> = (
  ctx: BaseCtx<E, RuleArgs>,
) => boolean | Promise<boolean>;

/**
 * Use-site argument value. Either a plain value (number/string/etc.) or a
 * `(ctx) => value` callback that resolves per event (ADR-002, ADR-004).
 *
 * The engine resolves callbacks against the rule's ctx, merges with the
 * predicate's registration args (registration wins), validates the merged
 * object against the predicate's Zod schema, and passes that to `.fn`.
 */
export type UseArgValue<E extends AnyEventPayload, RuleArgs, V> =
  | V
  | ((ctx: BaseCtx<E, RuleArgs>) => V);

/** Use-site args object — every field accepts either a value or a `(ctx) => value`. */
export type UseArgs<E extends AnyEventPayload, RuleArgs, PredicateArgs> = {
  [K in keyof PredicateArgs]?: UseArgValue<E, RuleArgs, PredicateArgs[K]>;
};

/**
 * Erased reference to a registered predicate, produced by `use(name, args?)`.
 *
 * The engine resolves `name` against the registry at register time
 * (dependency-graph check, ADR-016) and then again at evaluate time when
 * it looks up the predicate to invoke. The use-site args (which may contain
 * `(ctx) => value` callbacks) are resolved per event and merged with
 * registration args before Zod re-validation (ADR-004).
 */
export interface UseRef {
  readonly kind: 'use';
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/* ============================================================ *
 * Combinator nodes
 * ============================================================ */

export interface AllNode<E extends AnyEventPayload, RuleArgs> {
  readonly kind: 'all';
  readonly children: ReadonlyArray<WhenNode<E, RuleArgs>>;
}

export interface AnyNode<E extends AnyEventPayload, RuleArgs> {
  readonly kind: 'any';
  readonly children: ReadonlyArray<WhenNode<E, RuleArgs>>;
}

export interface NotNode<E extends AnyEventPayload, RuleArgs> {
  readonly kind: 'not';
  readonly child: WhenNode<E, RuleArgs>;
}

/**
 * One node in a `.when(...)` tree.
 *
 * - `AllNode` / `AnyNode` / `NotNode` — typed combinators.
 * - `UseRef` — leaf that resolves to a registered predicate by name.
 * - Inline function — `(ctx) => boolean | Promise<boolean>`.
 */
export type WhenNode<E extends AnyEventPayload, RuleArgs> =
  | AllNode<E, RuleArgs>
  | AnyNode<E, RuleArgs>
  | NotNode<E, RuleArgs>
  | UseRef
  | InlinePredicate<E, RuleArgs>;
