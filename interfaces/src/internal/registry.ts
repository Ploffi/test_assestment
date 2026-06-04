/**
 * Engine-internal registry — what `register()` materializes from a batch.
 *
 * After a successful `register()` the engine holds these immutable maps
 * for the lifetime of the registration cycle. Lookup-by-name is O(1) for
 * the `.action(name, ...)` and `use(name, ...)` resolution paths.
 */

import type {
  RegisteredPredicate,
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredScheduledAction,
  RegisteredIntegration,
  RegisteredRule,
  AnyRegisteredAction,
  WebhookEventName,
} from '../public/index.js';

/**
 * Phase-1 dispatch index: `event.name + '.' + event.action` → rules subscribed
 * via `.on(...)` (ADR-004).
 */
export type DispatchIndex = ReadonlyMap<
  WebhookEventName,
  ReadonlyArray<RegisteredRule<string, WebhookEventName, any>>
>;

export interface Registry {
  readonly predicates: ReadonlyMap<string, RegisteredPredicate<string, any>>;
  readonly actions: ReadonlyMap<string, RegisteredAction<string, any>>;
  readonly aggregatedActions: ReadonlyMap<
    string,
    RegisteredAggregatedAction<string, WebhookEventName, any, any>
  >;
  readonly scheduledActions: ReadonlyMap<string, RegisteredScheduledAction<string, any>>;
  readonly integrations: ReadonlyMap<string, RegisteredIntegration<string, any>>;
  readonly rules: ReadonlyMap<string, RegisteredRule<string, WebhookEventName, any>>;

  /** Unified lookup: a `.action(name, ...)` reference can be any of three kinds. */
  readonly actionByName: ReadonlyMap<string, AnyRegisteredAction>;

  /** Phase-1 dispatch (built once at register time). */
  readonly dispatch: DispatchIndex;
}
