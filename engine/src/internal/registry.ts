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
  IntegrationAdapter,
  IntegrationMethods,
  WebhookEventName,
} from '../public/index.js';

/**
 * Phase-1 dispatch index: `event.name + '.' + event.action` → rules subscribed
 * via `.on(...)` (ADR-004).
 */
export type DispatchIndex = Map<
  WebhookEventName,
  RegisteredRule<string, WebhookEventName, any>[]
>;

export interface Registry {
  readonly predicates: Map<string, RegisteredPredicate<string, any>>;
  readonly actions: Map<string, RegisteredAction<string, any>>;
  readonly aggregatedActions: Map<
    string,
    RegisteredAggregatedAction<string, WebhookEventName, any, any>
  >;
  readonly scheduledActions: Map<string, RegisteredScheduledAction<string, any>>;
  readonly integrations: Map<string, RegisteredIntegration<string, any>>;
  readonly rules: Map<string, RegisteredRule<string, WebhookEventName, any>>;

  /** Unified lookup: a `.action(name, ...)` reference can be any of three kinds. */
  readonly actionByName: Map<string, AnyRegisteredAction>;

  /** Phase-1 dispatch (built once at register time). */
  readonly dispatch: DispatchIndex;

  /** Resilience-wrapped integration adapters exposed as `ctx.integrations`. */
  readonly adapters: Record<string, IntegrationAdapter<IntegrationMethods>>;
}
