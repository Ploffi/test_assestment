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
