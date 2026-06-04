/**
 * Per-entity execution contexts (ADR-016).
 *
 * Every entity's `.fn(ctx)` (predicate, action, aggregated action, scheduled
 * action) and per-step callback (`when`, `transform`, `check`, `key`, `at`)
 * receives some flavour of context derived from `BaseCtx`. The shapes are
 * exactly what ADR-016 pins.
 */

import type { Logger } from './logger.js';
import type { AnyEventPayload, WebhookEventName, PayloadFor } from './webhook.js';
import type { IntegrationAdapter, IntegrationMethods } from './integration.js';

/** Lightweight repo / installation summary surfaced on ctx (ADR-011, ADR-016). */
export interface RepoRef {
  id: number;
  fullName: string;
}

export interface InstallationRef {
  id: number;
}

/**
 * Shared context base. Every entity-level ctx is a `BaseCtx<E, Args>` plus
 * kind-specific extras.
 *
 * `E` is narrowed by the entity's (or parent rule's) `.on(eventName)`.
 * `Args` is the merged + Zod-validated args (registration > use-site,
 * see ADR-002).
 */
export interface BaseCtx<E extends AnyEventPayload, Args> {
  /** Narrowed event payload — what `.on(name)` exposes. */
  event: E;

  /** Validated merged args. */
  args: Args;

  /** Per-evaluation cancellation (ADR-004, ADR-012). */
  signal: AbortSignal;

  /** `X-GitHub-Delivery` UUID (ADR-011). */
  deliveryId: string;

  /** Present when the payload carried an installation. */
  installation?: InstallationRef;

  /** Repo summary; absent on the few events that have no repository. */
  repo?: RepoRef;

  /**
   * Frozen wall-clock time at evaluation start, ms since epoch.
   * Read this instead of `Date.now()` so two predicates in the same
   * evaluation get the same answer (ADR-004, ADR-015).
   */
  now: number;

  /** Pino-compatible child logger, pre-bound with deliveryId / ruleId / entity name. */
  logger: Logger;

  /** Registered integrations, exposed by name. */
  integrations: Record<string, IntegrationAdapter<IntegrationMethods>>;
}

/* ============================================================ *
 * Aggregated-action ctx (ADR-006)
 * ============================================================ */

/** One previously-stored projected entry, surfaced on `ctx.aggregate.entries`. */
export interface AggregateEntryView {
  at: number;
  deliveryId: string;
  /** Whatever the aggregated action's `.transform` returned earlier. */
  payload: any;
}

export interface AggregateView {
  entries: ReadonlyArray<AggregateEntryView>;
  count: number;
  windowMs: number;
  keyId: string;
}

/** Ctx for `aggregatedAction.fn`. `.transform(ctx)` sees `BaseCtx<E, Args>` instead. */
export interface AggregatedCtx<
  N extends WebhookEventName,
  Args,
> extends BaseCtx<PayloadFor<N>, Args> {
  aggregate: AggregateView;
}

/* ============================================================ *
 * Scheduled-action ctx (ADR-007)
 * ============================================================ */

export interface ScheduledView {
  /** The rule's `.schedule({ transform })` output. Typed `any` per ADR-007 / ADR-016. */
  payload: any;
  /** ms since epoch when the rule enqueued this check. */
  scheduledAt: number;
  /** ms since epoch when the scheduler fired this check. */
  ranAt: number;
  keyId: string;
}

/**
 * Ctx for `scheduledAction.fn`.
 *
 * `event` is **not** present — the triggering payload was discarded after
 * `.schedule.transform` ran. The action only sees the projected payload via
 * `ctx.scheduled.payload`. Typed as `AnyEventPayload` for compatibility with
 * `BaseCtx`, but the engine never populates it for scheduled-action `.fn`
 * (the field is omitted at runtime). Authors should not touch it.
 */
export interface ScheduledCtx<Args> extends Omit<BaseCtx<AnyEventPayload, Args>, 'event'> {
  scheduled: ScheduledView;
}

/* ============================================================ *
 * Schedule-rule check ctx (ADR-007)
 * ============================================================ */

/**
 * Ctx for the rule's `.schedule({ check })` function.
 *
 * Same as `ScheduledCtx` minus `args` (the rule has its own args, not the
 * action's), exposing the rule's projected payload and metadata.
 */
export interface CheckCtx extends Omit<BaseCtx<AnyEventPayload, unknown>, 'event' | 'args'> {
  /** Rule-level args (validated). */
  args: unknown;
  /** The rule's `.schedule({ transform })` output. */
  payload: any;
  /** ms since epoch when the schedule was enqueued. */
  scheduledAt: number;
}
