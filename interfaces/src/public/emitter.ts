/**
 * Engine metrics emitter (ADR-011).
 *
 * The engine emits; the consumer aggregates. Implementation of metric
 * aggregation (counters, histograms, persistence) is out of scope for the
 * prototype.
 *
 * Every payload that is in the scope of a single evaluation carries
 * `deliveryId` so consumers can tie metrics back to logs / traces by the
 * same GitHub correlation id.
 */

/** Why a rule did not produce an action fire on this event. */
export type RuleSkipReason =
  | 'when-false'
  | 'aggregate-below-threshold'
  | 'scheduled-enqueued';

/** Outcome of a scheduled-rule `check`, as observed by the scheduler. */
export type ScheduledOutcome = 'pass' | 'skip' | 'recheck' | 'deadline_exceeded';

export interface RuleMatchedEvent {
  deliveryId: string;
  ruleId: string;
  elapsedMs: number;
}

export interface RuleSkippedEvent {
  deliveryId: string;
  ruleId: string;
  reason: RuleSkipReason;
}

export interface PredicateEvaluatedEvent {
  deliveryId: string;
  predicateName: string;
  result: boolean;
  elapsedMs: number;
  /** Engine-side per-event memoization hit (ADR-004). */
  cached: boolean;
}

export interface ExternalCallEvent {
  deliveryId: string;
  integrationName: string;
  methodName: string;
  ok: boolean;
  elapsedMs: number;
  /** Adapter-side cross-event TTL cache hit (ADR-005). */
  cacheHit: boolean;
  breakerState: 'closed' | 'open' | 'half-open';
}

export interface AggregateAppendedEvent {
  deliveryId: string;
  ruleId: string;
  actionId: string;
  keyId: string;
  count: number;
}

export interface ScheduledEnqueuedEvent {
  ruleId: string;
  keyId: string;
  runAt: number;
}

export interface ScheduledCheckedEvent {
  ruleId: string;
  keyId: string;
  outcome: ScheduledOutcome;
}

export interface EvaluationCompletedEvent {
  deliveryId: string;
  matchedCount: number;
  totalElapsedMs: number;
}

export interface EvaluationFailedEvent {
  deliveryId: string;
  error: unknown;
}

/* ============================================================ *
 * Discriminated union — pin `engine.on(name, cb)` to the right payload.
 * ============================================================ */

export interface EngineEventMap {
  'rule.matched': RuleMatchedEvent;
  'rule.skipped': RuleSkippedEvent;
  'predicate.evaluated': PredicateEvaluatedEvent;
  'external.call': ExternalCallEvent;
  'aggregate.appended': AggregateAppendedEvent;
  'scheduled.enqueued': ScheduledEnqueuedEvent;
  'scheduled.checked': ScheduledCheckedEvent;
  'evaluation.completed': EvaluationCompletedEvent;
  'evaluation.failed': EvaluationFailedEvent;
}

export type EngineEventName = keyof EngineEventMap;
export type EngineEventPayload<N extends EngineEventName> = EngineEventMap[N];
