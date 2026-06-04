/**
 * Per-evaluation engine-internal context (ADR-004).
 *
 * Created fresh for each `evaluate(envelope)` call. Carries the
 * memoization map keyed by `(predicate_name, args_hash)` so the same
 * `use(name, args)` across multiple rules in the same event resolves
 * to one in-flight Promise (DataLoader pattern).
 *
 * Distinct from the user-facing `BaseCtx`: rule authors never see this.
 */

import type { Logger } from '../public/logger.js';
import type { Clock } from '../public/clock.js';
import type {
  IntegrationAdapter,
  IntegrationMethods,
} from '../public/integration.js';
import type {
  EventEnvelope,
  WebhookEventName,
} from '../public/webhook.js';
import type { EmitFn } from './emitter.js';

/** Cache key for predicate memoization — `${name}@${args-hash}`. */
export type MemoKey = string;

/** The in-flight or settled Promise for one `(predicate, args)` resolution. */
export type MemoEntry = Promise<boolean>;

/** The live Promise for one predicate invocation. */
export interface MemoSlot {
  /** In-flight or settled. `false` on any throw per ADR-004 error isolation. */
  promise: MemoEntry;
}

/**
 * Engine-internal context for a single `evaluate(envelope)` call.
 *
 * One instance per evaluation; threaded into the evaluator,
 * predicate-protection wrapper, action runner, and store callers.
 */
export interface EvalContext<N extends WebhookEventName = WebhookEventName> {
  /** The envelope being evaluated. */
  envelope: EventEnvelope<N>;

  /** GitHub correlation id — same as `envelope.deliveryId`. */
  deliveryId: string;

  /** Frozen at evaluation start (ADR-004, ADR-015). */
  startedAt: number;

  /** Per-evaluation cancellation (composed: per-call signal + watchdog). */
  controller: AbortController;
  signal: AbortSignal;

  /** Memoization map for `use(name, args)` resolution. */
  memo: Map<MemoKey, MemoSlot>;

  /** Engine-scoped clock, propagated so tests can pin time. */
  clock: Clock;

  /** Pre-scoped logger with `{ deliveryId, repo, installation }` bound. */
  logger: Logger;

  /** Registered integrations exposed to entity `ctx.integrations`. */
  integrations: Record<string, IntegrationAdapter<IntegrationMethods>>;

  /** Emit a metrics event (ADR-011). */
  emit: EmitFn;
}
