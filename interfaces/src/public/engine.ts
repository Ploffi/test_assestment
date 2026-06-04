/**
 * Engine surface (ADR-014).
 *
 * Construction options + the `RuleEngine` interface that consumers see.
 * Implementation lives in `@air/engine`; this is the contract.
 */

import type { Logger } from './logger.js';
import type { Clock } from './clock.js';
import type { AggregationStore, ScheduledStore } from './stores.js';
import type {
  EventEnvelope,
  WebhookEventName,
} from './webhook.js';
import type {
  RegisteredPredicate,
  PredicateFactory,
} from './predicate.js';
import type {
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredScheduledAction,
} from './action.js';
import type { RegisteredRule } from './rule.js';
import type { RegisteredIntegration } from './integration.js';
import type {
  EngineEventName,
  EngineEventPayload,
} from './emitter.js';

/* ============================================================ *
 * Engine options
 * ============================================================ */

export interface EngineOptions {
  /** Pluggable rule state — in-memory defaults shipped (ADR-008). */
  aggregationStore?: AggregationStore;
  scheduledStore?: ScheduledStore;

  /** Time source — default `SystemClock` (ADR-015). */
  clock?: Clock;

  /** Pino-compatible logger — default no-op (ADR-011). */
  logger?: Logger;

  /** Per-evaluation watchdog deadline; default 15_000. */
  evaluationTimeoutMs?: number;

  /**
   * Scheduled-store poll cadence; default 10_000, minimum 10_000 (ADR-007).
   * Values below the minimum are clamped at construction time.
   */
  scheduledPollMs?: number;
}

/* ============================================================ *
 * Register batch
 * ============================================================ */

export interface RegisterBatch {
  predicates?: ReadonlyArray<RegisteredPredicate<string, any>>;
  actions?: ReadonlyArray<RegisteredAction<string, any>>;
  aggregatedActions?: ReadonlyArray<
    RegisteredAggregatedAction<string, WebhookEventName, any, any>
  >;
  scheduledActions?: ReadonlyArray<RegisteredScheduledAction<string, any>>;
  integrations?: ReadonlyArray<RegisteredIntegration<string, any>>;
  rules: ReadonlyArray<RegisteredRule<string, WebhookEventName, any>>;
}

/* ============================================================ *
 * Evaluate options
 * ============================================================ */

export interface EvaluateOptions {
  /** Override the envelope's correlation id; defaults to `envelope.deliveryId`. */
  deliveryId?: string;
  /** Per-call signal — composes with the engine's evaluation deadline. */
  signal?: AbortSignal;
}

/* ============================================================ *
 * Engine interface
 * ============================================================ */

/**
 * Public engine surface (ADR-014).
 *
 * `evaluate()` returns `Promise<void>` — resolves on success or clean skip,
 * rejects on action / engine-internal failure. Predicate failures stay
 * isolated to `false` per ADR-004 and do NOT reject `evaluate()`.
 */
export interface RuleEngine {
  /**
   * Synchronous, full-batch registration (ADR-002, ADR-016).
   *
   * Throws `RegistrationError` with the aggregated list of issues from both
   * passes. After a successful return the registry is immutable for this
   * engine instance; calling again replaces the batch wholesale.
   */
  register(batch: RegisterBatch): void;

  /**
   * Evaluate a webhook envelope against the registered rules.
   *
   * Rejects on action failure (aggregated across parallel-isolated actions)
   * or engine-internal failure; resolves `void` otherwise (ADR-014).
   */
  evaluate(envelope: EventEnvelope, opts?: EvaluateOptions): Promise<void>;

  /**
   * Subscribe to typed engine events for metrics aggregation (ADR-011).
   */
  on<N extends EngineEventName>(
    eventName: N,
    cb: (payload: EngineEventPayload<N>) => void,
  ): void;
  off<N extends EngineEventName>(
    eventName: N,
    cb: (payload: EngineEventPayload<N>) => void,
  ): void;

  /** Begin the scheduled-store poll loop (ADR-007). No-op if no scheduled rules. */
  start(): void;

  /** Stop the poll loop and cancel in-flight evaluations. */
  stop(): Promise<void>;
}

/* ============================================================ *
 * Top-level builder factory exports
 *
 * The engine package exposes these as values; here we pin their TYPE shapes
 * so consumer code (`import { predicate, action, rule, ... }`) typechecks.
 * ============================================================ */

import type {
  PredicateBuilder,
} from './predicate.js';
import type {
  ActionBuilder,
  AggregatedActionBuilder,
  ScheduledActionBuilder,
} from './action.js';
import type { RuleBuilder } from './rule.js';
import type { IntegrationBuilder } from './integration.js';
import type {
  WhenNode,
  UseRef,
  AllNode,
  AnyNode,
  NotNode,
} from './combinators.js';
import type { AnyEventPayload } from './webhook.js';

export type DefinePredicate = <Name extends string>(name: Name) => PredicateBuilder<Name>;
export type DefineAction = <Name extends string>(name: Name) => ActionBuilder<Name>;
export type DefineAggregatedAction = <Name extends string>(
  name: Name,
) => AggregatedActionBuilder<Name>;
export type DefineScheduledAction = <Name extends string>(
  name: Name,
) => ScheduledActionBuilder<Name>;
export type DefineRule = <Name extends string>(name: Name) => RuleBuilder<Name>;
export type DefineIntegration = <Name extends string>(name: Name) => IntegrationBuilder<Name>;

/**
 * Combinator factories. Return the specific node type (not the union
 * `WhenNode`) so the rule's `.when(node: ...)` overload picks them up
 * without ambiguity against the inline-function overload.
 */
export type AllFactory = <E extends AnyEventPayload, RuleArgs>(
  ...children: ReadonlyArray<WhenNode<E, RuleArgs>>
) => AllNode<E, RuleArgs>;
export type AnyFactory = <E extends AnyEventPayload, RuleArgs>(
  ...children: ReadonlyArray<WhenNode<E, RuleArgs>>
) => AnyNode<E, RuleArgs>;
export type NotFactory = <E extends AnyEventPayload, RuleArgs>(
  child: WhenNode<E, RuleArgs>,
) => NotNode<E, RuleArgs>;
/**
 * `use(name, args?)` reference. Args values are either plain literals or
 * `(ctx) => value` callbacks that resolve per event (ADR-002, ADR-004).
 *
 * The args record is typed as `any` so use-site callbacks don't trip
 * `noImplicitAny`; TypeScript cannot propagate the surrounding rule's
 * `<E, RuleArgs>` down through this opaque factory, so authors who want
 * narrowed `ctx` annotate the callback explicitly. The runtime validates
 * the merged + resolved args against the referenced predicate's Zod
 * schema before passing to `.fn` (ADR-004).
 */
/** Value shape for use-site args at the factory boundary — explicit function arm so `(ctx) =>` does not trip `noImplicitAny`. */
export type UseFactoryArgValue =
  | ((ctx: any) => unknown)
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | readonly unknown[]
  | { readonly [key: string]: unknown };

export type UseFactory = (
  name: string,
  args?: { readonly [key: string]: UseFactoryArgValue },
) => UseRef;
