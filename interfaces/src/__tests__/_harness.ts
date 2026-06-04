/**
 * Test harness.
 *
 * Declares the runtime entry points the engine package will eventually
 * provide. Bodies are `declare`d, so tests typecheck against the public
 * surface but the harness emits no runtime code — `tsc --noEmit` passes,
 * `node --test` would fail at import time. Tests in this directory are a
 * compile-time CONTRACT for the future implementation, not a test suite
 * that runs today.
 *
 * When the engine implementation is written, it should re-export the same
 * names and these declarations can be replaced with `import { ... } from
 * '@air/engine'` (or wherever the package lands).
 */

import type {
  DefinePredicate,
  DefineAction,
  DefineAggregatedAction,
  DefineScheduledAction,
  DefineRule,
  DefineIntegration,
  AllFactory,
  AnyFactory,
  NotFactory,
  UseFactory,
  EngineOptions,
  RuleEngine,
  EventEnvelope,
  WebhookEventName,
  PayloadFor,
  Clock,
  ManualClock,
  Logger,
  AggregationStore,
  ScheduledStore,
} from '../public/index.js';

/* ============================================================ *
 * Builder factories (will be exported by @air/engine)
 * ============================================================ */

export declare const predicate: DefinePredicate;
export declare const action: DefineAction;
export declare const aggregatedAction: DefineAggregatedAction;
export declare const scheduledAction: DefineScheduledAction;
export declare const rule: DefineRule;
export declare const integration: DefineIntegration;

/* ============================================================ *
 * Combinators
 * ============================================================ */

export declare const all: AllFactory;
export declare const any: AnyFactory;
export declare const not: NotFactory;
export declare const use: UseFactory;

/* ============================================================ *
 * Engine factory + bundled default stores / clock
 * ============================================================ */

export declare function createEngine(opts?: EngineOptions): RuleEngine;

export declare function createInMemoryAggregationStore(): AggregationStore;
export declare function createInMemoryScheduledStore(): ScheduledStore;
export declare function createManualClock(initial?: number): ManualClock;
export declare function createSystemClock(): Clock;
export declare function createNoopLogger(): Logger;

/* ============================================================ *
 * Test helpers — synthesize a typed envelope without constructing
 * a full webhook payload. The harness lies to tsc: at runtime the
 * payload would be whatever the test passes; at compile time the
 * field accesses inside predicates / actions remain typechecked.
 * ============================================================ */

export declare function fakeEnvelope<N extends WebhookEventName>(
  name: N,
  payload?: Partial<PayloadFor<N>>,
  deliveryId?: string,
): EventEnvelope<N>;
