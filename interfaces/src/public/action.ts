/**
 * Three action kinds (ADR-002, ADR-006, ADR-007, ADR-016).
 *
 *  1. `action`             — plain. ctx.event is the triggering payload.
 *  2. `aggregatedAction`   — pinned `.on(eventName)` + `.transform(ctx) => payload`;
 *                            ctx.fn receives the projected window via ctx.aggregate.
 *  3. `scheduledAction`    — no `.on`, no `.transform` on the action; the rule
 *                            owns `.schedule({ transform })`. ctx.fn sees only
 *                            the stored payload via ctx.scheduled.
 *
 * Rules attach all three with the same `.action(name, args?)`; the engine
 * determines kind by looking up `name` in the registry (ADR-006, ADR-016).
 */

import type { z } from 'zod';
import type {
  BaseCtx,
  AggregatedCtx,
  ScheduledCtx,
} from './ctx.js';
import type { AnyEventPayload, WebhookEventName, PayloadFor } from './webhook.js';

/* ============================================================ *
 * Plain action
 * ============================================================ */

export type ActionImpl<Args> = (
  ctx: BaseCtx<AnyEventPayload, Args>,
) => void | Promise<void>;

export interface RegisteredAction<
  Name extends string = string,
  Args = unknown,
> {
  readonly kind: 'action';
  readonly name: Name;
  readonly argsSchema: z.ZodType<Args>;
  readonly pinnedArgs: Partial<Args>;
  fn(ctx: BaseCtx<AnyEventPayload, Args>): void | Promise<void>;
}

export interface ActionBuilder<Name extends string> {
  args<S extends z.ZodType>(schema: S): ActionBuilderWithArgs<Name, z.infer<S>>;
}

export interface ActionBuilderWithArgs<Name extends string, Args> {
  fn(impl: ActionImpl<Args>): ActionFactory<Name, Args>;
}

export type ActionFactory<Name extends string, Args> = (
  registrationArgs?: Partial<Args>,
) => RegisteredAction<Name, Args>;

/* ============================================================ *
 * Aggregated action (ADR-006)
 * ============================================================ */

export type TransformFn<N extends WebhookEventName, Args, Payload> = (
  ctx: BaseCtx<PayloadFor<N>, Args>,
) => Payload;

export type AggregatedActionImpl<N extends WebhookEventName, Args> = (
  ctx: AggregatedCtx<N, Args>,
) => void | Promise<void>;

export interface RegisteredAggregatedAction<
  Name extends string = string,
  N extends WebhookEventName = WebhookEventName,
  Args = unknown,
  Payload = unknown,
> {
  readonly kind: 'aggregatedAction';
  readonly name: Name;
  readonly eventName: N;
  readonly argsSchema: z.ZodType<Args>;
  readonly pinnedArgs: Partial<Args>;
  transform(ctx: BaseCtx<PayloadFor<N>, Args>): Payload;
  fn(ctx: AggregatedCtx<N, Args>): void | Promise<void>;
}

export interface AggregatedActionBuilder<Name extends string> {
  on<N extends WebhookEventName>(eventName: N): AggregatedActionBuilderWithOn<Name, N>;
}

export interface AggregatedActionBuilderWithOn<Name extends string, N extends WebhookEventName> {
  args<S extends z.ZodType>(schema: S): AggregatedActionBuilderWithArgs<Name, N, z.infer<S>>;
}

export interface AggregatedActionBuilderWithArgs<
  Name extends string,
  N extends WebhookEventName,
  Args,
> {
  transform<Payload>(
    fn: TransformFn<N, Args, Payload>,
  ): AggregatedActionBuilderWithTransform<Name, N, Args, Payload>;
}

export interface AggregatedActionBuilderWithTransform<
  Name extends string,
  N extends WebhookEventName,
  Args,
  Payload,
> {
  fn(impl: AggregatedActionImpl<N, Args>): AggregatedActionFactory<Name, N, Args, Payload>;
}

export type AggregatedActionFactory<
  Name extends string,
  N extends WebhookEventName,
  Args,
  Payload,
> = (
  registrationArgs?: Partial<Args>,
) => RegisteredAggregatedAction<Name, N, Args, Payload>;

/* ============================================================ *
 * Scheduled action (ADR-007)
 * ============================================================ */

export type ScheduledActionImpl<Args> = (
  ctx: ScheduledCtx<Args>,
) => void | Promise<void>;

export interface RegisteredScheduledAction<
  Name extends string = string,
  Args = unknown,
> {
  readonly kind: 'scheduledAction';
  readonly name: Name;
  readonly argsSchema: z.ZodType<Args>;
  readonly pinnedArgs: Partial<Args>;
  fn(ctx: ScheduledCtx<Args>): void | Promise<void>;
}

export interface ScheduledActionBuilder<Name extends string> {
  args<S extends z.ZodType>(schema: S): ScheduledActionBuilderWithArgs<Name, z.infer<S>>;
}

export interface ScheduledActionBuilderWithArgs<Name extends string, Args> {
  fn(impl: ScheduledActionImpl<Args>): ScheduledActionFactory<Name, Args>;
}

export type ScheduledActionFactory<Name extends string, Args> = (
  registrationArgs?: Partial<Args>,
) => RegisteredScheduledAction<Name, Args>;

/* ============================================================ *
 * Union over all action kinds — used by the rule builder's `.action(...)`
 * and the registry.
 * ============================================================ */

export type AnyRegisteredAction =
  | RegisteredAction
  | RegisteredAggregatedAction
  | RegisteredScheduledAction;
