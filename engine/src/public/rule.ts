/**
 * Rule entity (ADR-002, ADR-006, ADR-007, ADR-016).
 *
 * Builder shape:
 *
 *   rule(name)
 *     [ .args(schema) ]?
 *     .on(eventName)
 *     .when(node)
 *     [ .aggregate({ window, count, key, at? }) | .schedule({ delay, deadline?, key, transform, check }) ]?
 *     .action(name, args?)+
 *     -> RuleFactory
 *
 * Builder settings are reusable: calling `.args(...)`, `.on(...)`, `.when(...)`,
 * `.aggregate(...)`, or `.schedule(...)` again replaces the previous value.
 * `.aggregate(...)` and `.schedule(...)` overwrite the strategy with the last
 * call. `.action(...)` remains additive because rules support action chains.
 */

import type { z } from 'zod';
import type { BaseCtx, CheckCtx } from './ctx.js';
import type { WebhookEventName, PayloadFor } from './webhook.js';
import type {
  WhenNode,
  AllNode,
  AnyNode,
  NotNode,
  UseRef,
} from './combinators.js';
import type { CheckResult } from './stores.js';

/** Duration string ('1h', '5m', '30s') or ms count. */
export type Duration = string | number;

/* ============================================================ *
 * Aggregate / schedule step configs
 * ============================================================ */

export interface AggregateConfig<N extends WebhookEventName, RuleArgs> {
  window: Duration;
  count: number;
  key: (ctx: BaseCtx<PayloadFor<N>, RuleArgs>) => string;
  /** Optional override for entry timestamp (defaults to `ctx.now`). */
  at?: (ctx: BaseCtx<PayloadFor<N>, RuleArgs>) => number;
}

export interface ScheduleConfig<N extends WebhookEventName, RuleArgs> {
  delay: Duration;
  deadline?: Duration;
  key: (ctx: BaseCtx<PayloadFor<N>, RuleArgs>) => string;
  transform: (ctx: BaseCtx<PayloadFor<N>, RuleArgs>) => unknown;
  check: (ctx: CheckCtx) => Promise<CheckResult>;
}

/* ============================================================ *
 * Action attach references
 * ============================================================ */

/** Action attachment on a rule — name + optional use-site args. */
export interface ActionAttachment {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

/* ============================================================ *
 * Registered shapes
 * ============================================================ */

export interface PlainStrategy {
  readonly kind: 'plain';
}

export interface AggregateStrategy {
  readonly kind: 'aggregate';
  readonly window: Duration;
  readonly count: number;
  key(ctx: BaseCtx<any, any>): string;
  at?(ctx: BaseCtx<any, any>): number;
}

export interface ScheduleStrategy {
  readonly kind: 'schedule';
  readonly delay: Duration;
  readonly deadline?: Duration;
  key(ctx: BaseCtx<any, any>): string;
  transform(ctx: BaseCtx<any, any>): unknown;
  check(ctx: CheckCtx): Promise<CheckResult>;
}

export type RuleStrategy = PlainStrategy | AggregateStrategy | ScheduleStrategy;

export interface RegisteredRule<
  Name extends string = string,
  N extends WebhookEventName = WebhookEventName,
  Args = unknown,
> {
  readonly kind: 'rule';
  readonly name: Name;
  readonly eventName: N;
  readonly argsSchema: z.ZodType<Args>;
  readonly pinnedArgs: Partial<Args>;
  /**
   * `when` is widened to `WhenNode<any, any>` on the registered shape so a
   * heterogeneous `register({ rules: [...] })` array compiles. The builder
   * still type-checks the tree against the rule's narrowed `E` / `Args` at
   * the `.when(...)` call site; the engine recovers the narrow ctx at
   * evaluate time from `eventName` + the registry.
   */
  readonly when: WhenNode<any, any>;
  readonly strategy: RuleStrategy;
  readonly actions: ReadonlyArray<ActionAttachment>;
}

/* ============================================================ *
 * Reusable builder
 * ============================================================ */

export interface RuleBuilder<
  Name extends string,
  N extends WebhookEventName = WebhookEventName,
  Args = unknown,
> {
  args<S extends z.ZodType>(schema: S): RuleBuilderWithArgs<Name, z.infer<S>>;
  on<NextN extends WebhookEventName>(eventName: NextN): RuleBuilderWithOn<Name, NextN, Args>;
  /**
   * `.when` accepts either an inline `(ctx) => boolean` leaf or a structured
   * combinator tree (`all` / `any` / `not` / `use`). Single signature so TS
   * picks the right union arm contextually for arrow arguments.
   */
  when(
    node:
      | ((ctx: BaseCtx<PayloadFor<N>, Args>) => boolean | Promise<boolean>)
      | AllNode<PayloadFor<N>, Args>
      | AnyNode<PayloadFor<N>, Args>
      | NotNode<PayloadFor<N>, Args>
      | UseRef,
  ): RuleBuilderWithWhen<Name, N, Args>;
  aggregate(cfg: AggregateConfig<N, Args>): RuleBuilderAggregating<Name, N, Args>;
  schedule(cfg: ScheduleConfig<N, Args>): RuleBuilderScheduling<Name, N, Args>;
  action(name: string, args?: Record<string, unknown>): RuleBuilderTerminal<Name, N, Args>;
  (registrationArgs?: Partial<Args>): RegisteredRule<Name, N, Args>;
}

export type RuleBuilderWithArgs<Name extends string, Args> = RuleBuilder<Name, WebhookEventName, Args>;

export type RuleBuilderWithOn<
  Name extends string,
  N extends WebhookEventName,
  Args,
> = RuleBuilder<Name, N, Args>;

export type RuleBuilderWithWhen<
  Name extends string,
  N extends WebhookEventName,
  Args,
> = RuleBuilder<Name, N, Args>;

export type RuleBuilderAggregating<
  Name extends string,
  N extends WebhookEventName,
  Args,
> = RuleBuilder<Name, N, Args>;

export type RuleBuilderScheduling<
  Name extends string,
  N extends WebhookEventName,
  Args,
> = RuleBuilder<Name, N, Args>;

/**
 * Terminal — can chain more `.action(...)` calls. Also callable as a factory
 * (invoke with registration args to get a `RegisteredRule`).
 */
export type RuleBuilderTerminal<
  Name extends string,
  N extends WebhookEventName,
  Args,
> = RuleBuilder<Name, N, Args>;

/* ============================================================ *
 * Factory exported as `rule(name)`
 * ============================================================ */

export type RuleFactory = <Name extends string>(name: Name) => RuleBuilder<Name>;
