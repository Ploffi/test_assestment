/**
 * Predicate entity (ADR-002, ADR-004, ADR-016).
 *
 * Builder shape: `predicate(name).args(schema).fn(impl)` produces a callable
 * `PredicateFactory<Args>` that consumers call with optional registration
 * args to get a `RegisteredPredicate`.
 *
 * Builder settings are reusable: calling `.args(...)` or `.fn(...)` again
 * replaces the previous value.
 *
 * Predicates are leaf-only — they cannot `use(...)` other predicates;
 * composition lives in `all` / `any` / `not` on the rule (ADR-004).
 */

import type { z } from 'zod';
import type { BaseCtx } from './ctx.js';
import type { AnyEventPayload } from './webhook.js';

export type PredicateImpl<Args> = (
  ctx: BaseCtx<AnyEventPayload, Args>,
) => boolean | Promise<boolean>;

/** Registered instance — what `engine.register({ predicates })` consumes. */
export interface RegisteredPredicate<
  Name extends string = string,
  Args = unknown,
> {
  readonly kind: 'predicate';
  readonly name: Name;
  readonly argsSchema: z.ZodType<Args>;
  /** Args pinned at registration time. Merged with use-site args (registration wins). */
  readonly pinnedArgs: Partial<Args>;
  /** Method-form so params are bivariant — required for heterogeneous register batches. */
  fn(ctx: BaseCtx<AnyEventPayload, Args>): boolean | Promise<boolean>;
}

/* ============================================================ *
 * Reusable builder
 * ============================================================ */

export interface PredicateBuilder<Name extends string, Args = unknown> {
  args<S extends z.ZodType>(schema: S): PredicateBuilderWithArgs<Name, z.infer<S>>;
  fn(impl: PredicateImpl<Args>): PredicateFactory<Name, Args>;
}

export type PredicateBuilderWithArgs<Name extends string, Args> = PredicateFactory<Name, Args>;

/**
 * Callable factory — invoking with optional registration args produces a
 * `RegisteredPredicate`. Args precedence: registration > use-site (ADR-002).
 */
export interface PredicateFactory<Name extends string, Args> extends PredicateBuilder<Name, Args> {
  (registrationArgs?: Partial<Args>): RegisteredPredicate<Name, Args>;
}
